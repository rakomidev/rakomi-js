/**
 * RFC 6749 §4.1.3 authorization-code → token exchange. Platform-neutral.
 *
 * uses `HttpClient` adapter, never global `fetch`. Returns
 * typed result; never throws.
 */

import type { HttpClient } from '../types/adapters.js';
import type { OAuthTokenResponse } from '../types/auth.js';
import type { AuthError } from '../types/auth-error.js';
import { networkError, parseTokenEndpointError } from './errors.js';

export interface ExchangeAuthCodeInput {
  http: HttpClient;
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  /**
 * Optional RFC 9449 DPoP proof attached as the `DPoP` request header
 * (opt-in at issuance).
 * When the integrator binds a session, a proof is presented at issuance so the
 * server binds `dpop_jkt` to the key it saw here; the SAME key must then sign
 * every refresh proof. Additive + web-safe: the web SDK never sets it.
 */
  dpopProof?: string;
}

export type TokenExchangeResult =
  | { ok: true; tokens: OAuthTokenResponse }
  | {
      ok: false;
      error: AuthError;
      /**
       * RFC 9449 §8 server nonce (from the `DPoP-Nonce` response header) when the
       * failure was a `use_dpop_nonce` challenge — the caller retries ONCE with
       * the nonce echoed into a freshly-signed proof. Additive optional field;
       * unset for non-DPoP refreshes (web ignores it).
       */
      dpopNonce?: string;
      /**
       * `true` when the server rejected the DPoP proof itself (`invalid_dpop_proof`)
       * rather than the refresh token — lets the caller surface the distinct,
       * rollback-actionable `invalid_dpop_proof` class apart from a genuine
       * `invalid_refresh_token`. Additive optional field.
       */
      dpopProofRejected?: boolean;
    };

export async function exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
  });
  let response: Response;
  try {
    response = await input.http.fetch(input.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...(input.dpopProof ? { DPoP: input.dpopProof } : {}),
      },
      body,
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'fetch failed') };
  }

  if (!response.ok) {
    let body: { error?: string; error_description?: string } = {};
    try {
      body = (await response.json()) as { error?: string; error_description?: string };
    } catch {
    }
    return { ok: false, error: parseTokenEndpointError(response.status, body) };
  }

  try {
    const tokens = (await response.json()) as OAuthTokenResponse;
    if (typeof tokens.access_token !== 'string' || typeof tokens.expires_in !== 'number') {
      return { ok: false, error: { code: 'CODE_EXCHANGE_FAILED', message: 'malformed token response' } };
    }
    return { ok: true, tokens };
  } catch {
    return { ok: false, error: { code: 'CODE_EXCHANGE_FAILED', message: 'token response not JSON' } };
  }
}

/**
 * RFC 6749 refresh-token grant. Used by both web and RN runtimes.
 * On 401/403/invalid_grant the SDK clears tokens (server-side reuse-detection
 * already invalidated the family per OAuth 2.1).
 */
export async function refreshAccessToken(input: {
  http: HttpClient;
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  /**
 * Optional RFC 9449 DPoP proof attached as the `DPoP` request header
 * Present for a DPoP-bound session;
 * absent (Bearer) otherwise. Additive + web-safe.
 */
  dpopProof?: string;
}): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  let response: Response;
  try {
    response = await input.http.fetch(input.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...(input.dpopProof ? { DPoP: input.dpopProof } : {}),
      },
      body,
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'fetch failed') };
  }
  if (!response.ok) {
    let parsed: { error?: string; error_description?: string } = {};
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
    }
    const wwwAuth = response.headers.get('WWW-Authenticate') ?? '';
    const wwwError = /\berror="([^"]+)"/.exec(wwwAuth)?.[1];
    const oauthError = parsed.error ?? wwwError;
    if (oauthError === 'use_dpop_nonce') {
      const dpopNonceRaw = response.headers.get('DPoP-Nonce');
      const dpopNonce = dpopNonceRaw !== null && dpopNonceRaw.length > 0 ? dpopNonceRaw : undefined;
      const result: { ok: false; error: AuthError; dpopNonce?: string } = {
        ok: false,
        error: parseTokenEndpointError(response.status, parsed),
      };
      if (dpopNonce !== undefined) result.dpopNonce = dpopNonce;
      return result;
    }
    if (oauthError === 'invalid_dpop_proof') {
      return { ok: false, error: parseTokenEndpointError(response.status, parsed), dpopProofRejected: true };
    }
    return { ok: false, error: parseTokenEndpointError(response.status, parsed) };
  }
  try {
    const tokens = (await response.json()) as OAuthTokenResponse;
    if (typeof tokens.access_token !== 'string' || typeof tokens.expires_in !== 'number') {
      return { ok: false, error: { code: 'REFRESH_FAILED', reason: 'revoked', message: 'malformed token response' } };
    }
    return { ok: true, tokens };
  } catch {
    return { ok: false, error: { code: 'REFRESH_FAILED', reason: 'revoked', message: 'token response not JSON' } };
  }
}
