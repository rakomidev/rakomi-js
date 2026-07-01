/**
 * OAuth error factories — platform-neutral.
 * Maps RFC 6749 error codes to the typed AuthError union.
 *
 * Single source of truth for web + RN SDKs.
 */

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

/** Map token endpoint error to typed AuthError. */
export function parseTokenEndpointError(
  status: number,
  body: { error?: string; error_description?: string },
): AuthError {
  const errorCode = body.error ?? 'unknown';
  const description = body.error_description ?? errorCode;

  if (errorCode === 'invalid_grant' || status === 401 || status === 403) {
    return { code: 'REFRESH_FAILED', reason: 'revoked', message: description };
  }

  return { code: 'CODE_EXCHANGE_FAILED', message: description };
}

/** Create a network-error AuthError (for fetch failures, 5xx, timeouts). */
export function networkError(message: string): AuthError {
  return { code: 'REFRESH_FAILED', reason: 'network', message };
}
