/**
 * `useAuth()` — RN port of `@rakomi/react`'s `useAuth`. Parity-tested at type level.
 * Returns the same discriminated-union AuthState shape so consumer code is portable.
 */

'use client';

import type { AuthError, AuthMachineState, HasParams, SignInOptions, SignInResult, SwitchOrgResult, TokenResult, UserResource } from '@rakomi/sdk-core';
import { hasPermission, hasRole } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

/**
 * Discriminated-union AuthState — identical to `@rakomi/react`'s `AuthState`.
 *
 * `state: AuthMachineState` is the addition.
 */
export type AuthState =
  | {
      isLoaded: false;
      isSignedIn: undefined;
      userId: undefined;
      user: undefined;
      sessionId: undefined;
      error: null;
      state: AuthMachineState;
      signIn: (options?: SignInOptions) => Promise<SignInResult>;
      signOut: () => Promise<void>;
      getToken: () => Promise<TokenResult>;
    }
  | {
      isLoaded: true;
      isSignedIn: false;
      userId: null;
      user: null;
      sessionId: null;
      error: AuthError | null;
      state: AuthMachineState;
      signIn: (options?: SignInOptions) => Promise<SignInResult>;
      signOut: () => Promise<void>;
      getToken: () => Promise<TokenResult>;
    }
  | {
      isLoaded: true;
      isSignedIn: true;
      userId: string;
      user: UserResource;
      sessionId: string;
      error: AuthError | null;
      state: AuthMachineState;
      isExpiringSoon: boolean;
      has: (params: HasParams) => boolean;
      signIn: (options?: SignInOptions) => Promise<SignInResult>;
      signOut: () => Promise<void>;
      getToken: () => Promise<TokenResult>;
      switchOrganization: (orgId: string | null) => Promise<SwitchOrgResult>;
    };

export function useAuth(): AuthState {
  const ctx = useRakomiContext();
  const { snapshot, signOut, state, getToken } = ctx;

  const signIn = async (_options?: SignInOptions): Promise<SignInResult> => {
    return { status: 'error', error: { code: 'INVALID_CONFIG', message: 'sign-in flow not yet wired in 0.1.0' } };
  };
  const switchOrganization = async (_orgId: string | null): Promise<SwitchOrgResult> => ({ status: 'error', error: { code: 'INVALID_CONFIG', message: 'switchOrganization not yet wired' } });

  if (state === 'idle') {
    return {
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      user: null,
      sessionId: null,
      error: snapshot.error,
      state,
      signIn,
      signOut,
      getToken,
    };
  }
  if (state === 'authenticating') {
    return {
      isLoaded: false,
      isSignedIn: undefined,
      userId: undefined,
      user: undefined,
      sessionId: undefined,
      error: null,
      state,
      signIn,
      signOut,
      getToken,
    };
  }
  if (snapshot.user && snapshot.session) {
    return {
      isLoaded: true,
      isSignedIn: true,
      userId: snapshot.user.id,
      user: snapshot.user,
      sessionId: snapshot.session.id,
      error: snapshot.error,
      state,
      isExpiringSoon: snapshot.session.isExpiringSoon ?? false,
      has: (params: HasParams) => {
        if (params.permission && hasPermission(snapshot.user!, params.permission)) return true;
        if (params.role && hasRole(snapshot.user!, params.role)) return true;
        return false;
      },
      signIn,
      signOut,
      getToken,
      switchOrganization,
    };
  }
  return {
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    user: null,
    sessionId: null,
    error: snapshot.error,
    state,
    signIn,
    signOut,
    getToken,
  };
}
