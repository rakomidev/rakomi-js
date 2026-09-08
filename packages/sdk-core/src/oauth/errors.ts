/**
 * OAuth error factories — platform-neutral.
 * Maps RFC 6749 error codes to the typed AuthError union.
 *
 * Single source of truth for web + RN SDKs.
 */

import { extractRequestId } from '../internal/request-id.js';
import type { AuthError } from '../types/auth-error.js';

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
 * ALREADY-ESTABLISHED session, so a 401/403/`invalid_grant` correctly means that session's
 * refresh token was revoked/reused — `REFRESH_FAILED`. `'exchange'` is the FIRST `POST
 * /oauth/token` of a brand-new sign-in (`grant_type=authorization_code`) — no session exists yet
 * to have been "refreshed" or "revoked", so a rejected code exchange is always
 * `CODE_EXCHANGE_FAILED` regardless of status, never `REFRESH_FAILED`. Before this distinction
 * existed, a rejected code exchange (e.g. a misconfigured OAuth client) surfaced as
 * `REFRESH_FAILED` with `reason: 'revoked'` — wrong on its face (nothing had been issued yet to
 * revoke) and, for any caller that maps `REFRESH_FAILED` to "clear the session and show a
 * session-expired message", actively misleading during the one moment a user has never yet had
 * a session.
 */
export function parseTokenEndpointError(
  status: number,
  body: { error?: string; error_description?: string; request_id?: string },
  context: 'exchange' | 'refresh' = 'refresh',
): AuthError {
  const errorCode = body.error ?? 'unknown';
  const description = body.error_description ?? errorCode;
  const requestId = extractRequestId(body);

  if (context === 'exchange') {
    return { code: 'CODE_EXCHANGE_FAILED', message: description, ...(requestId && { requestId }) };
  }

  if (errorCode === 'invalid_grant' || status === 401 || status === 403) {
    return { code: 'REFRESH_FAILED', reason: 'revoked', message: description, ...(requestId && { requestId }) };
  }

  return { code: 'CODE_EXCHANGE_FAILED', message: description, ...(requestId && { requestId }) };
}

/** Create a network-error AuthError (for fetch failures, 5xx, timeouts). */
export function networkError(message: string): AuthError {
  return { code: 'REFRESH_FAILED', reason: 'network', message };
}
