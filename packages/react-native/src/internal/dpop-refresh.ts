
import type { HttpClient, OAuthTokenResponse } from '@rakomi/sdk-core';
import { refreshAccessToken } from '@rakomi/sdk-core';

import type { DpopSession } from './dpop-session.js';

/** RFC 9449 / three-class client-side refresh failure taxonomy (+ network). */
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

function err(cls: DpopRefreshErrorClass, message: string): { ok: false; error: DpopRefreshError } {
  return { ok: false, error: { class: cls, code: `auth/${cls}`, message } };
}

function proverUnavailable(message = 'DPoP prover unavailable'): { ok: false; error: DpopRefreshError } {
  return err('dpop_prover_unavailable', message);
}

/**
 * Refresh the access token, attaching a DPoP proof IFF the session is bound.
 * Performs the single bounded nonce retry and maps every failure into the
 * three-class taxonomy. On success, re-confirms bound-truth from `token_type`.
 */
export async function refreshWithDpop(input: RefreshWithDpopInput): Promise<DpopRefreshResult> {
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
  result: { ok: false; error: { code: string; reason?: string; message?: string }; dpopNonce?: string; dpopProofRejected?: boolean },
  attachedProof: boolean,
): { ok: false; error: DpopRefreshError } {
  const message = result.error.message ?? 'refresh failed';
  if (attachedProof && (result.dpopProofRejected || result.dpopNonce !== undefined)) {
    return err('invalid_dpop_proof', message);
  }
  if (result.error.code === 'REFRESH_FAILED' && result.error.reason === 'network') {
    return err('network', message);
  }
  return err('invalid_refresh_token', message);
}
