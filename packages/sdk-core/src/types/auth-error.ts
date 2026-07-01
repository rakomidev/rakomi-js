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
 */
export type AuthError =
  | { code: 'REFRESH_FAILED'; reason: 'expired' | 'revoked' | 'network'; message: string }
  | { code: 'OAUTH_CALLBACK_ERROR'; oauthError: string; description: string }
  | { code: 'TENANT_SUSPENDED'; reason: string; appealUrl?: string }
  | { code: 'CSRF_MISMATCH'; message: string }
  | { code: 'CODE_EXCHANGE_FAILED'; message: string }
  | { code: 'SIGN_IN_FAILED'; message: string }
  | { code: 'INVALID_CONFIG'; message: string }
  | { code: 'NETWORK_ERROR'; message: string }
  | { code: 'PROVIDER_ERROR'; message: string };

/** Extract a display-safe message from any AuthError variant. */
export function getErrorMessage(error: AuthError): string {
  if (error.code === 'OAUTH_CALLBACK_ERROR') return error.description;
  if (error.code === 'TENANT_SUSPENDED') return error.reason;
  if ('message' in error) return error.message;
  return 'An unexpected error occurred';
}
