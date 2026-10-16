/**
 * Browser-safe OAuth token endpoint helpers.
 * No client_secret — public client with PKCE is sole proof.
 *
 * All fetch calls use credentials: 'omit' to prevent accidental cookie leakage
 * and avoid CORS credential conflicts with the Rakomi API's origin-echo configuration.
 */

import {
  isSettledRefreshResult,
  parseRetryAfterMs,
  refreshOutcomeUnknownError,
  refreshRetryOnceTriggerOf,
  refreshWithOneImmediateRetry,
} from '@rakomi/sdk-core';

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { OAuthTokenResponse } from '../types.js';
import { networkError, parseTokenEndpointError, unreadableRefreshResponseError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';

type TokenResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: false; error: import('../types.js').AuthError };

/**
 * Exchange an authorization code for tokens.
 * Public client: no client_secret (PKCE code_verifier is sole proof per RFC 6749 §2.1).
 */
export async function exchangeCode(options: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  baseUrl?: string;
}): Promise<TokenResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  });

  return tokenRequest(baseUrl, body, 'exchange');
}

/**
 * Refresh an access token using a refresh token.
 * Public client: no client_secret needed (session is bound to client via oauthClientId).
 *
 * A 5xx other than 503 and 521–523, or a transport failure (no response arrived), is retried once,
 * immediately (the server may have rotated the token before failing or before its answer was lost,
 * and hands the rotation back to an identical retry within its window). If
 * that retry does not settle the refresh, the outcome is unknown and the result is a terminal
 * `REFRESH_FAILED` (`reason: 'revoked'`): the session ends and the user signs in again — the
 * token is never presented later.
 */
export async function refreshToken(options: {
  refreshToken: string;
  clientId: string;
  baseUrl?: string;
}): Promise<TokenResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });

  const outcome = await refreshWithOneImmediateRetry({
    send: () => tokenRequest(baseUrl, body, 'refresh'),
    retryOnceTrigger: refreshRetryOnceTriggerOf,
    isSettled: isSettledRefreshResult,
  });
  if (outcome.uncertainAfter !== undefined) {
    return { ok: false, error: refreshOutcomeUnknownError(outcome.uncertainAfter) };
  }
  return outcome.result;
}

/**
 * `context` distinguishes the two callers above (see `parseTokenEndpointError`'s own doc
 * comment for the full rationale): `'exchange'` is a brand-new sign-in with no established
 * session yet, so every failure here — network, malformed response, or a rejected grant — is
 * `CODE_EXCHANGE_FAILED`, never `REFRESH_FAILED`. For `'refresh'`, a transport failure is
 * transient (`'network'`), while a 2xx whose body cannot be read is terminal (`'revoked'` with the
 * 2xx `status`): the server already rotated the refresh token, so it must never be sent again.
 */
async function tokenRequest(baseUrl: string, body: URLSearchParams, context: 'exchange' | 'refresh'): Promise<TokenResult> {
  const failure = (message: string): TokenResult =>
    context === 'exchange'
      ? { ok: false, error: { code: 'CODE_EXCHANGE_FAILED', message } }
      : { ok: false, error: networkError(message) };
  const unreadable2xx = (status: number, message: string): TokenResult =>
    context === 'exchange'
      ? { ok: false, error: { code: 'CODE_EXCHANGE_FAILED', message } }
      : { ok: false, error: unreadableRefreshResponseError(status, message) };

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    return failure(normalizeNetworkError(err));
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const errorBody = (typeof json === 'object' && json !== null ? json : {}) as { error?: string; error_description?: string; request_id?: string };
    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), Date.now());
    return { ok: false, error: parseTokenEndpointError(response.status, errorBody, context, retryAfterMs) };
  }
  if (json === undefined || typeof json !== 'object' || json === null) {
    return unreadable2xx(response.status, 'Invalid JSON response from token endpoint');
  }

  const r = json as Record<string, unknown>;
  if (
    typeof r['access_token'] !== 'string' ||
    r['access_token'].length === 0 ||
    r['access_token'].length > 8192 ||
    typeof r['expires_in'] !== 'number' ||
    typeof r['token_type'] !== 'string'
  ) {
    return unreadable2xx(response.status, 'Invalid token response shape from token endpoint');
  }

  const data: OAuthTokenResponse = {
    access_token: r['access_token'],
    token_type: r['token_type'],
    expires_in: r['expires_in'],
    ...(typeof r['refresh_token'] === 'string' && r['refresh_token'].length > 0
      ? { refresh_token: r['refresh_token'] }
      : {}),
  };
  return { ok: true, data };
}
