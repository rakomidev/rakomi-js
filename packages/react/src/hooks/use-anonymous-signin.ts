/**
 * useAnonymousSignin
 *
 * Thin wrapper over useAuth.signIn({ mode: 'anonymous' }) that carries its own
 * isLoading + error state for UI ergonomics.
 *
 * SECURITY NOTE: the `isAnonymous` flag must come from a
 * VERIFIED JWT — never from URL, localStorage, or uncontrolled state. Use
 * `useAuth.user.isAnonymous` for that check. This hook only handles the
 * sign-in call; it does not set any trust flag itself.
 */

import { useCallback, useState } from 'react';

import type { AuthError } from '../types.js';
import { useAuth } from './use-auth.js';

export interface UseAnonymousSigninResult {
  signIn: (options?: { publicMetadata?: Record<string, unknown> }) => Promise<void>;
  isLoading: boolean;
  error: AuthError | null;
}

export function useAnonymousSignin(): UseAnonymousSigninResult {
  const auth = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const signIn = useCallback(
    async (options?: { publicMetadata?: Record<string, unknown> }) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await auth.signIn({ mode: 'anonymous', publicMetadata: options?.publicMetadata });
        if (result.status === 'error') {
          setError(result.error);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [auth],
  );

  return { signIn, isLoading, error };
}
