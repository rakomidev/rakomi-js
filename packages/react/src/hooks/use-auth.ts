/**
 * useAuth — primary auth hook for @rakomi/react.
 *
 * Returns a discriminated union AuthState<T> with 3 states:
 * - { isLoaded: false } — initial load, storage restore in progress
 * - { isLoaded: true, isSignedIn: false } — no session
 * - { isLoaded: true, isSignedIn: true } — active session
 *
 * Generic T extends Record<string, unknown> for custom JWT claims (forward-compatible with future claim shapes).
 * TypeScript narrows each branch automatically — no manual null-checks needed.
 */

import { useRakomiContext } from '../context.js';
import type { AuthState } from '../types.js';

/**
 * Returns the current auth state.
 * Must be called inside a <RakomiProvider>.
 *
 * @example
 * const { isLoaded, isSignedIn, user, signIn, signOut, getToken } = useAuth();
 * if (!isLoaded) return <Spinner />;
 * if (!isSignedIn) return <LoginButton onClick={() => signIn({ mode: 'redirect' })} />;
 * return <Dashboard userId={user.id} />;
 */
export function useAuth<T extends Record<string, unknown> = Record<string, never>>(): AuthState<T> {
  return useRakomiContext() as AuthState<T>;
}
