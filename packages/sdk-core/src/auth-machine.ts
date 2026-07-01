/**
 * Auth state machine — pure FSM, no I/O.
 *
 * `useAuth.state` exposes the discrete machine state.
 * Both `@rakomi/react` and `@rakomi/react-native` drive UI off the same state set.
 *
 * Design:
 * - Inputs are typed `Action`s; outputs are typed `MachineState`s.
 * - A reducer-style function maps `(state, action) → state`.
 * - Side effects (storage I/O, fetch) are NOT here — runtimes decide based on the next state.
 */

import type { AuthMachineState, SessionResource, UserResource } from './types/auth.js';
import type { AuthError } from './types/auth-error.js';

export interface MachineSnapshot {
  state: AuthMachineState;
  user: UserResource | null;
  session: SessionResource | null;
  /** Last error attached to the snapshot — set on transitions to 'error' or transient retry. */
  error: AuthError | null;
  /** Set when state === 'awaiting_mfa'; opaque server token. */
  challengeToken?: string;
  challengeAcr?: string;
}

export type MachineAction =
  | { type: 'INIT' }
  | { type: 'RESTORE_SUCCESS'; user: UserResource; session: SessionResource }
  | { type: 'RESTORE_FAILED' }
  | { type: 'SIGN_IN_START' }
  | { type: 'SIGN_IN_SUCCESS'; user: UserResource; session: SessionResource }
  | { type: 'MFA_REQUIRED'; challengeToken: string; expiresIn: number; requiredAcr?: string }
  | { type: 'MFA_VERIFIED'; user: UserResource; session: SessionResource }
  | { type: 'SIGN_IN_FAILED'; error: AuthError }
  | { type: 'REFRESH_START' }
  | { type: 'REFRESH_SUCCESS'; session: SessionResource }
  | { type: 'REFRESH_NETWORK_ERROR'; error: AuthError }
  | { type: 'REFRESH_REVOKED'; error: AuthError }
  | { type: 'OFFLINE_STALE' }
  | { type: 'BACK_ONLINE' }
  | { type: 'SIGN_OUT' };

export const INITIAL_SNAPSHOT: MachineSnapshot = {
  state: 'idle',
  user: null,
  session: null,
  error: null,
};

export function reduce(snapshot: MachineSnapshot, action: MachineAction): MachineSnapshot {
  switch (action.type) {
    case 'INIT':
      return { ...INITIAL_SNAPSHOT };
    case 'RESTORE_SUCCESS':
      return { state: 'authenticated', user: action.user, session: action.session, error: null };
    case 'RESTORE_FAILED':
      return { state: 'idle', user: null, session: null, error: null };
    case 'SIGN_IN_START':
      return { ...snapshot, state: 'authenticating', error: null };
    case 'SIGN_IN_SUCCESS':
    case 'MFA_VERIFIED':
      return { state: 'authenticated', user: action.user, session: action.session, error: null };
    case 'MFA_REQUIRED':
      return {
        ...snapshot,
        state: 'awaiting_mfa',
        challengeToken: action.challengeToken,
        challengeAcr: action.requiredAcr,
        error: null,
      };
    case 'SIGN_IN_FAILED':
      return { state: 'error', user: null, session: null, error: action.error };
    case 'REFRESH_START':
      if (snapshot.state !== 'authenticated' && snapshot.state !== 'offline_stale') return snapshot;
      return { ...snapshot, state: 'refreshing', error: null };
    case 'REFRESH_SUCCESS':
      return { ...snapshot, state: 'authenticated', session: action.session, error: null };
    case 'REFRESH_NETWORK_ERROR':
      return { ...snapshot, state: 'authenticated', error: action.error };
    case 'REFRESH_REVOKED':
      return { state: 'idle', user: null, session: null, error: action.error };
    case 'OFFLINE_STALE':
      if (snapshot.state !== 'authenticated' && snapshot.state !== 'refreshing') return snapshot;
      return { ...snapshot, state: 'offline_stale' };
    case 'BACK_ONLINE':
      return { ...snapshot, state: snapshot.state === 'offline_stale' ? 'authenticated' : snapshot.state };
    case 'SIGN_OUT':
      return { ...INITIAL_SNAPSHOT };
  }
}

/**
 * Projection: derive `useAuth().isSignedIn` from a machine snapshot.
 * `authenticated` AND `refreshing` AND `offline_stale` ALL count as signed-in
 * (parity with web SDK — refresh/network errors don't sign the user out).
 */
export function isSignedIn(snapshot: MachineSnapshot): boolean {
  return snapshot.state === 'authenticated' || snapshot.state === 'refreshing' || snapshot.state === 'offline_stale';
}

/** Minutes until refresh is due, given a session. */
export function shouldRefresh(session: SessionResource | null, thresholdSeconds = 60): boolean {
  if (!session) return false;
  return session.expiresInSeconds <= thresholdSeconds;
}
