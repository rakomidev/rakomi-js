/**
 * Typed auth-error discriminated union.
 *
 * Single source of truth — both `@rakomi/react` and `@rakomi/react-native` re-export
 * this type so consumer code is portable across platforms.
 *
 * Forward-compatible additions:
 * - 'biometric_cancelled' | 'biometric_lockout' | 'biometric_not_enrolled' | 'biometric_unavailable'
 * are added to REFRESH_FAILED reasons via SdkError reasons in the platform shim, NOT here —
 * this type stays platform-neutral.
 *
 * Every variant carries an optional `requestId` — the server's per-request correlation id (same
 * id the API logs and returns via `X-Request-Id`), when the failed call's response body carried
 * one. Present on any error built from an actual HTTP response; absent for a purely local error
 * (a network failure, config validation, an OAuth redirect-callback error with no response body
 * to read). Never fabricated — a caller can hand it back to Rakomi support for log correlation.
 */
export type AuthError =
  | { code: 'REFRESH_FAILED'; reason: 'expired' | 'revoked' | 'network'; message: string; requestId?: string }
  | { code: 'OAUTH_CALLBACK_ERROR'; oauthError: string; description: string; requestId?: string }
  | { code: 'TENANT_SUSPENDED'; reason: string; appealUrl?: string; requestId?: string }
  | { code: 'CSRF_MISMATCH'; message: string; requestId?: string }
  | { code: 'CODE_EXCHANGE_FAILED'; message: string; requestId?: string }
  | { code: 'SIGN_IN_FAILED'; message: string; requestId?: string }
  | { code: 'INVALID_CONFIG'; message: string; requestId?: string }
  | { code: 'NETWORK_ERROR'; message: string; requestId?: string }
  | { code: 'PROVIDER_ERROR'; message: string; requestId?: string };

/** Extract a display-safe message from any AuthError variant. */
export function getErrorMessage(error: AuthError): string {
  if (error.code === 'OAUTH_CALLBACK_ERROR') return error.description;
  if (error.code === 'TENANT_SUSPENDED') return error.reason;
  if ('message' in error) return error.message;
  return 'An unexpected error occurred';
}
