/**
 * OAuth error factories — platform-neutral.
 * Maps RFC 6749 error codes to the typed AuthError union.
 *
 * Single source of truth for web + RN SDKs.
 */

import { extractRequestId } from '../internal/request-id.js';
import type { AuthError } from '../types/auth-error.js';
import { isDefinitiveRefreshRejection, isTransientStatus } from './refresh-retry.js';

/** Map an RFC 6749 error response to a typed AuthError. */
export function parseOAuthCallbackError(
  error: string,
  errorDescription?: string,
): AuthError {
  return {
    code: 'OAUTH_CALLBACK_ERROR',
    oauthError: error,
    description: errorDescription ?? error,
  };
}

/**
 * Map token endpoint error to typed AuthError.
 *
 * `context` distinguishes the two calls that share this parser: `'refresh'` (the default, and
 * the ONLY behavior before this parameter existed) is a `POST /oauth/token` for an
 * ALREADY-ESTABLISHED session, so a definitive rejection (`invalid_grant`, a bare 401, …) means
 * that session's refresh token was revoked/reused — `REFRESH_FAILED`. `'exchange'` is the FIRST `POST
 * /oauth/token` of a brand-new sign-in (`grant_type=authorization_code`) — no session exists yet
 * to have been "refreshed" or "revoked", so a rejected code exchange is always
 * `CODE_EXCHANGE_FAILED` regardless of status, never `REFRESH_FAILED`. Before this distinction
 * existed, a rejected code exchange (e.g. a misconfigured OAuth client) surfaced as
 * `REFRESH_FAILED` with `reason: 'revoked'` — wrong on its face (nothing had been issued yet to
 * revoke) and, for any caller that maps `REFRESH_FAILED` to "clear the session and show a
 * session-expired message", actively misleading during the one moment a user has never yet had
 * a session.
 *
 * For `'refresh'`, only a definitive rejection (see `isDefinitiveRefreshRejection`) is
 * `REFRESH_FAILED` with `reason: 'revoked'`. A 5xx, 429 or 408 is `REFRESH_FAILED` with
 * `reason: 'network'` — the session survives a server outage or a rate limit, and the runtime
 * retries. Any other rejection is `CODE_EXCHANGE_FAILED`. Every variant keeps the HTTP `status`
 * and the server's `oauthError` code, and a transient one keeps `retryAfterMs`.
 */
export function parseTokenEndpointError(
  status: number,
  body: { error?: string; error_description?: string; request_id?: string },
  context: 'exchange' | 'refresh' = 'refresh',
  retryAfterMs?: number,
): AuthError {
  const oauthError = typeof body.error === 'string' && body.error.length > 0 ? body.error : undefined;
  const description = body.error_description ?? oauthError ?? `token endpoint returned HTTP ${status}`;
  const requestId = extractRequestId(body);
  const detail = { status, ...(oauthError && { oauthError }), ...(requestId && { requestId }) };

  if (context === 'exchange') {
    return { code: 'CODE_EXCHANGE_FAILED', message: description, ...detail };
  }

  if (isTransientStatus(status)) {
    return {
      code: 'REFRESH_FAILED',
      reason: 'network',
      message: description,
      ...detail,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    };
  }

  if (isDefinitiveRefreshRejection(status, oauthError)) {
    return { code: 'REFRESH_FAILED', reason: 'revoked', message: description, ...detail };
  }

  return { code: 'CODE_EXCHANGE_FAILED', message: description, ...detail };
}

/** Create a transient refresh AuthError for a failure with no usable HTTP response (fetch failure, timeout, unreadable body). */
export function networkError(message: string): AuthError {
  return { code: 'REFRESH_FAILED', reason: 'network', message };
}
