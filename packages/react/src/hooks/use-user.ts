/**
 * useUser() — convenience hook for accessing the current user resource.
 *
 * Returns a discriminated union:
 *   - { isLoaded: false; user: undefined }   — initial load in progress
 *   - { isLoaded: true; user: null }          — signed out
 *   - { isLoaded: true; user: UserResource }  — signed in
 */

import { useRakomiContext } from '../context.js';
import type { UserResource } from '../types.js';

export type UseUserReturn =
  | { isLoaded: false; user: undefined }
  | { isLoaded: true; user: UserResource | null };

/**
 * Returns the current user resource, or null if signed out.
 * Must be called inside a <RakomiProvider>.
 *
 * @example
 * const { isLoaded, user } = useUser();
 * if (!isLoaded) return null;
 * return user ? <p>Hello, {user.email}</p> : null;
 */
export function useUser(): UseUserReturn {
  const auth = useRakomiContext();

  if (!auth.isLoaded) {
    return { isLoaded: false, user: undefined };
  }

  return {
    isLoaded: true,
    user: auth.isSignedIn ? auth.user : null,
  };
}
