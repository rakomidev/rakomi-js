/**
 * useSession — convenience hook for accessing the current session resource.
 *
 * Returns a discriminated union:
 * - { isLoaded: false; session: undefined } — initial load in progress
 * - { isLoaded: true; session: null } — signed out
 * - { isLoaded: true; session: SessionResource } — signed in
 *
 * SessionResource:
 * - expiresAt: derived from JWT exp claim (raw timestamp * 1000). For clock-skew-immune
 * expiry logic, use getToken which returns expiresIn computed from Date.now + expires_in.
 * - lastActiveAt: from JWT iat claim (token issue time).
 * - isExpiringSoon: reactive — driven by centralized TokenManager timer.
 * True when session will effectively expire within the configured threshold (default 5 min).
 * - expiresInSeconds: render-time snapshot. NOT a live counter.
 * For a live countdown, use your own setInterval(1000) calling useSession each tick.
 */

import { useRakomiContext } from '../context.js';
import type { SessionResource } from '../types.js';

export type UseSessionReturn =
  | { isLoaded: false; session: undefined }
  | { isLoaded: true; session: SessionResource | null };

/**
 * Returns the current session resource, or null if signed out.
 * Must be called inside a <RakomiProvider>.
 *
 * @example
 * const { isLoaded, session } = useSession();
 * if (!isLoaded) return null;
 * if (!session) return <SignInButton />;
 * if (session.isExpiringSoon) return <SessionExpiryWarning expiresInSeconds={session.expiresInSeconds} />;
 * return <Dashboard />;
 */
export function useSession(): UseSessionReturn {
  const auth = useRakomiContext();

  if (!auth.isLoaded) {
    return { isLoaded: false, session: undefined };
  }

  if (!auth.isSignedIn) {
    return { isLoaded: true, session: null };
  }

  const rawClaims = auth.user.rawClaims;
  const exp = typeof rawClaims['exp'] === 'number' ? rawClaims['exp'] * 1000 : 0;
  const iat = typeof rawClaims['iat'] === 'number' ? rawClaims['iat'] * 1000 : Date.now();

  const maxLifetimeExpSeconds = rawClaims['session_max_lifetime_exp'];
  const maxLifetimeExpiresAt: number | undefined =
    typeof maxLifetimeExpSeconds === 'number'
      ? maxLifetimeExpSeconds * 1000
      : undefined;

  const effectiveExpiresAt = Math.min(exp, maxLifetimeExpiresAt ?? Infinity);

  const expiresInSeconds = Math.max(0, Math.floor((effectiveExpiresAt - Date.now()) / 1000));

  const session: SessionResource = {
    id: auth.sessionId,
    userId: auth.userId,
    tenantId: auth.user.tenantId,
    expiresAt: exp,
    lastActiveAt: iat,
    maxLifetimeExpiresAt,
    effectiveExpiresAt,
    expiresInSeconds,
    isExpiringSoon: auth.isExpiringSoon,
  };

  return { isLoaded: true, session };
}
