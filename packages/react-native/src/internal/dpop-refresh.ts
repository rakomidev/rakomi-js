
import type { AuthError, HttpClient, OAuthTokenResponse } from '@rakomi/sdk-core';
import {
  refreshAccessToken,
  refreshOutcomeUnknownError,
  refreshRetryOnceTriggerOf,
  refreshWithOneImmediateRetry,
} from '@rakomi/sdk-core';

import type { DpopSession } from './dpop-session.js';

/**
 * RFC 9449 / three-class client-side refresh failure taxonomy (+ network).
 *
 * `network` is every transient failure — no connection, a 503, 521–523, 429 or 408 — and also
 * any rejection that is not definitive. (Another 5xx is retried once at once; see `refreshWithDpop`.) The session is kept and retried;
 * only `invalid_refresh_token` and `invalid_dpop_proof` end it.
 */
export type DpopRefreshErrorClass =
  | 'dpop_prover_unavailable'
  | 'invalid_dpop_proof'
  | 'invalid_refresh_token'
  | 'network';

export interface DpopRefreshError {
  /** Stable machine token for the failure class. */
  class: DpopRefreshErrorClass;
  /** Full `auth/<class>` code string — parity with `@rakomi/node`'s surfacing. */
  code: `auth/${DpopRefreshErrorClass}`;
  message: string;
  /** The underlying token-endpoint failure (HTTP status, OAuth `error`, `Retry-After`), when there was one. */
  cause?: AuthError;
}

export type DpopRefreshResult =
  | { ok: true; tokens: OAuthTokenResponse; attachedProof: boolean }
  | { ok: false; error: DpopRefreshError };

export interface RefreshWithDpopInput {
  http: HttpClient;
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  /** When bound, a proof is attached; absent / unbound ⇒ a plain Bearer refresh. */
  dpopSession?: DpopSession;
}

function err(cls: DpopRefreshErrorClass, message: string, cause?: AuthError): { ok: false; error: DpopRefreshError } {
  return { ok: false, error: { class: cls, code: `auth/${cls}`, message, ...(cause && { cause }) } };
}

function proverUnavailable(message = 'DPoP prover unavailable'): { ok: false; error: DpopRefreshError } {
  return err('dpop_prover_unavailable', message);
}

/**
 * Refresh the access token, attaching a DPoP proof IFF the session is bound.
 * Performs the single bounded nonce retry and maps every failure into the
 * three-class taxonomy. On success, re-confirms bound-truth from `token_type`.
 *
 * A 5xx other than 503 and 521–523, or a transport failure (no response arrived), is
 * retried once, immediately, with a fresh proof from the same key: the server may have
 * rotated the token before failing or before its answer was lost, and hands the rotation
 * back to an identical retry within its window. If that retry is not a
 * success or a definitive rejection, the outcome is unknown and the result is
 * `invalid_refresh_token` (cause: `REFRESH_FAILED` / `revoked` with the first
 * status, none after a transport failure) — the session ends and the token is never presented later.
 */
export async function refreshWithDpop(input: RefreshWithDpopInput): Promise<DpopRefreshResult> {
  const outcome = await refreshWithOneImmediateRetry({
    send: () => refreshWithDpopOnce(input),
    retryOnceTrigger: (r) => (!r.ok && r.error.class === 'network' && r.error.cause ? refreshRetryOnceTriggerOf({ ok: false, error: r.error.cause }) : undefined),
    isSettled: (r) => r.ok || r.error.class === 'invalid_refresh_token' || r.error.class === 'invalid_dpop_proof',
  });
  if (outcome.uncertainAfter !== undefined) {
    const cause = refreshOutcomeUnknownError(outcome.uncertainAfter);
    return err('invalid_refresh_token', cause.code === 'REFRESH_FAILED' ? cause.message : 'refresh outcome unknown', cause);
  }
  return outcome.result;
}

async function refreshWithDpopOnce(input: RefreshWithDpopInput): Promise<DpopRefreshResult> {
  const session = input.dpopSession;
  const bound = session?.isBound === true;

  if (!bound || !session) {
    const result = await refreshAccessToken({
      http: input.http,
      tokenEndpoint: input.tokenEndpoint,
      refreshToken: input.refreshToken,
      clientId: input.clientId,
    });
    if (result.ok) {
      await session?.observeTokenType(result.tokens.token_type, false);
      return { ok: true, tokens: result.tokens, attachedProof: false };
    }
    return mapFailure(result, false);
  }

  let proof: string;
  try {
    proof = await session.resolveProof('POST', input.tokenEndpoint);
  } catch (e) {
    return proverUnavailable(e instanceof Error ? e.message : 'DPoP prover threw');
  }
  if (!proof) return proverUnavailable('DPoP prover returned an empty proof');

  let result = await refreshAccessToken({
    http: input.http,
    tokenEndpoint: input.tokenEndpoint,
    refreshToken: input.refreshToken,
    clientId: input.clientId,
    dpopProof: proof,
  });

  if (!result.ok && result.dpopNonce !== undefined) {
    let retryProof: string;
    try {
      retryProof = await session.resolveProof('POST', input.tokenEndpoint, { nonce: result.dpopNonce });
    } catch (e) {
      return proverUnavailable(e instanceof Error ? e.message : 'DPoP prover threw on nonce retry');
    }
    if (!retryProof) return proverUnavailable('DPoP prover returned an empty proof on nonce retry');
    result = await refreshAccessToken({
      http: input.http,
      tokenEndpoint: input.tokenEndpoint,
      refreshToken: input.refreshToken,
      clientId: input.clientId,
      dpopProof: retryProof,
    });
  }

  if (result.ok) {
    await session.observeTokenType(result.tokens.token_type, true);
    return { ok: true, tokens: result.tokens, attachedProof: true };
  }
  return mapFailure(result, true);
}

/** Map a `refreshAccessToken` failure into the three-class taxonomy. */
function mapFailure(
  result: { ok: false; error: AuthError; dpopNonce?: string; dpopProofRejected?: boolean },
  attachedProof: boolean,
): { ok: false; error: DpopRefreshError } {
  const message = 'message' in result.error ? result.error.message : 'refresh failed';
  if (attachedProof && (result.dpopProofRejected || result.dpopNonce !== undefined)) {
    return err('invalid_dpop_proof', message, result.error);
  }
  if (result.error.code === 'REFRESH_FAILED' && (result.error.reason === 'revoked' || result.error.reason === 'expired')) {
    return err('invalid_refresh_token', message, result.error);
  }
  return err('network', message, result.error);
}
