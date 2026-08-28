'use client';

/**
 * usePasskeys
 *
 * Sign in with a passkey, register one, and manage the list — with the browser ceremony and the
 * React session already wired up. The orchestration itself (REST choreography, error mapping,
 * ceremony budget) lives in `@rakomi/sdk-core`; this hook injects the browser binding and the HTTP
 * client, holds the React state, and hands a successful assertion to the provider so `useAuth()`
 * flips to signed-in exactly as it does for every other sign-in path.
 *
 * Like the rest of this package it uses plain React state — no data-fetching library — so it adds
 * no runtime dependency to your app. Wrap it in your own cache if you want one.
 *
 * ## Step-up tokens
 *
 * Registering, listing, renaming, and deleting a passkey are step-up gated: the server demands a
 * fresh re-authentication, because changing which keys can sign you in is itself a sensitive act.
 * **You pass the step-up token in explicitly**, and this SDK never stores it. That is a deliberate
 * design: the token expires on the server's clock, so a cached one gives false confidence, and a
 * shipped library holding a replay-capable secret in module scope would leak it across React roots,
 * tests, and micro-frontends.
 *
 * Mint one with {@link UsePasskeysResult.stepUpWithPasskey}, then pass it to the gated call:
 *
 * ```tsx
 * const { stepUpWithPasskey, registerPasskey } = usePasskeys();
 * const stepUp = await stepUpWithPasskey();
 * if (stepUp.ok) await registerPasskey({ stepUpToken: stepUp.stepUpToken, nickname: 'MacBook' });
 * ```
 *
 * When a gated call comes back with `error.nextAction === 'step-up'`, mint a fresh token and retry;
 * the hook will not do it behind your back, because an AAL2 re-authentication is something your UI
 * should be able to explain to the user.
 *
 * **The first passkey is the exception.** `stepUpWithPasskey` asserts a passkey the user already
 * has, so it cannot bootstrap the very first one. That one needs a *password* step-up — this SDK
 * ships no client for it yet, so call `POST /v1/auth/step-up/password` yourself and pass the
 * resulting token into `registerPasskey`. The token is an ordinary string: which leg minted it does
 * not matter.
 *
 * **Handle the token like the bearer secret it is:** keep it in memory for the one call it is for,
 * never put it in a URL, `localStorage`, a log line, or an analytics event. Treat it defensively as
 * single-use — mint a fresh one per gated call rather than holding one and reusing it.
 *
 * ## Signing in as a *different* user
 *
 * `signInWithPasskey()` establishes the session through the provider, which refuses to swap one
 * signed-in user for another mid-session (a session-fixation guard). So if a user is already signed
 * in as A and the authenticator picker selects B's passkey, the provider clears the session rather
 * than switching to B. Call `signOut()` first if account-switching is what your UI intends.
 *
 * ## Nothing happens on mount
 *
 * Rendering this hook makes **no network call**. It only probes the browser's capabilities.
 * `passkeys` stays `undefined` until you call `listPasskeys({ stepUpToken })` — merely showing a
 * page never pulls a user's authenticator inventory over the wire.
 *
 * ## One ceremony at a time, per page
 *
 * The underlying WebAuthn library keeps a page-global abort service: starting a second ceremony
 * anywhere on the page silently aborts the first, which the first caller then sees as a
 * cancellation indistinguishable from a real user dismissal. This hook guards its own actions
 * against re-entry (a double-click is a no-op), but it cannot see a *different* component's
 * ceremony. Avoid mounting two ceremony-triggering components at once, or gate them behind a lock
 * in your app.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  assertPasskey,
  type AssertPasskeyResult,
  deletePasskey as deletePasskeyCore,
  type DeletePasskeyResult,
  isPasskeySupported,
  listPasskeys as listPasskeysCore,
  type ListPasskeysResult,
  type OpaqueUserHandle,
  type PasskeyCeremonyAdapter,
  type PasskeyError,
  passkeyError,
  type PasskeySummary,
  type PasskeySummaryResult,
  registerPasskey as registerPasskeyCore,
  type RegisterPasskeyResult,
  renamePasskey as renamePasskeyCore,
  stepUpWithPasskey as stepUpWithPasskeyCore,
  type StepUpWithPasskeyResult,
} from '@rakomi/sdk-core';

import { useRakomiInternals } from '../internal/use-auth-internals.js';
import { createSdkHttpClient } from '../lib/http-client-adapter.js';
import {
  createBrowserPasskeyAdapter,
  isPlatformAuthenticatorAvailable,
} from '../passkeys/browser-adapter.js';
import type { OAuthTokenResponse } from '../types.js';
import { useAuth } from './use-auth.js';

export interface UsePasskeysOptions {
  /**
   * Replace the browser ceremony binding.
   *
   * The seam exists so a test can inject a fake adapter instead of mocking the WebAuthn library,
   * and so an exotic host (a WebView bridge, a hardware-token integration) can supply its own.
   * Applications should not normally pass this.
   */
  adapter?: PasskeyCeremonyAdapter;
}

export interface SignInWithPasskeyInput {
  /**
   * Identified sign-in. Omit it for the usernameless flow, where the authenticator picks the
   * credential.
   *
   * ⚠️ It must be a value the **server** issued — e.g. one carried by a passkey listing.
   * It is never a form field. The `OpaqueUserHandle` brand is compile-time only:
   * `asOpaqueUserHandle` validates nothing, it casts. An email or username passed here is written to
   * the user's authenticator, outside the server's control (WebAuthn L3 §14.6.1) — a
   * data-minimisation failure under art. 5(1)(c) / art. 25 GDPR that no runtime check can undo.
   */
  userHandle?: OpaqueUserHandle;
}

export interface RegisterPasskeyHookInput {
  /** A fresh step-up token. See the hook docs — the SDK never stores or mints one for you. */
  stepUpToken: string;
  /** A human label for the key, 1–64 characters. */
  nickname?: string;
}

export interface ListPasskeysHookInput {
  stepUpToken: string;
}

export interface RenamePasskeyHookInput {
  passkeyId: string;
  nickname: string;
  stepUpToken: string;
}

export interface DeletePasskeyHookInput {
  passkeyId: string;
  stepUpToken: string;
}

export interface UsePasskeysResult {
  /** `null` until the capability probe resolves. `false` means this browser cannot do WebAuthn. */
  isSupported: boolean | null;
  /** `null` until probed. A UI hint ("offer Face ID wording") — never a gate. */
  hasPlatformAuthenticator: boolean | null;
  /** `undefined` until `listPasskeys` is called — the hook fetches nothing on mount. */
  passkeys: PasskeySummary[] | undefined;
  error: PasskeyError | null;
  isSigningIn: boolean;
  isRegistering: boolean;
  isSteppingUp: boolean;
  isLoading: boolean;
  isMutating: boolean;
  signInWithPasskey: (input?: SignInWithPasskeyInput) => Promise<AssertPasskeyResult>;
  stepUpWithPasskey: () => Promise<StepUpWithPasskeyResult>;
  registerPasskey: (input: RegisterPasskeyHookInput) => Promise<RegisterPasskeyResult>;
  listPasskeys: (input: ListPasskeysHookInput) => Promise<ListPasskeysResult>;
  renamePasskey: (input: RenamePasskeyHookInput) => Promise<PasskeySummaryResult>;
  deletePasskey: (input: DeletePasskeyHookInput) => Promise<DeletePasskeyResult>;
}

type ActionKey = 'signIn' | 'register' | 'stepUp' | 'list' | 'mutate';

/** The actions that open a native authenticator prompt — they contend for ONE page-global sheet. */
const CEREMONY_ACTIONS: ReadonlySet<ActionKey> = new Set<ActionKey>(['signIn', 'register', 'stepUp']);

function isCeremonyBusy(busy: Record<ActionKey, boolean>): boolean {
  return busy.signIn || busy.register || busy.stepUp;
}

type ResultLike = { ok: true } | { ok: false; error: PasskeyError };

interface Session {
  accessToken: string;
  userId: string;
}

export function usePasskeys(options: UsePasskeysOptions = {}): UsePasskeysResult {
  const auth = useAuth();
  const internals = useRakomiInternals();

  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [hasPlatformAuthenticator, setHasPlatformAuthenticator] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | undefined>(undefined);
  const [error, setError] = useState<PasskeyError | null>(null);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [isRegistering, setIsRegistering] = useState<boolean>(false);
  const [isSteppingUp, setIsSteppingUp] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isMutating, setIsMutating] = useState<boolean>(false);

  const injectedAdapter = options.adapter;
  const adapter = useMemo(
    () => injectedAdapter ?? createBrowserPasskeyAdapter(),
    [injectedAdapter],
  );
  const http = useMemo(() => createSdkHttpClient(), []);

  const mountedRef = useRef<boolean>(true);
  /**
   * Re-entrancy is tracked in a ref, not in the busy state: a second click lands in the same React
   * batch as the first, where the state has not updated yet, and a stale-closure read would let it
   * through.
   */
  const busyRef = useRef<Record<ActionKey, boolean>>({
    signIn: false,
    register: false,
    stepUp: false,
    list: false,
    mutate: false,
  });
  /**
   * Every in-flight action's controller. Unmounting aborts them all — which cancels the ceremony
   * and the HTTP leg, not merely the `setState` that would have followed. Without it an unmounted
   * registration still mints a server-side credential no UI ever confirmed, and an abandoned
   * step-up mints a replay-capable token nobody reads.
   */
  const inFlightRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    const inFlight = inFlightRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supported = await isPasskeySupported(adapter);
      if (!cancelled && mountedRef.current) setIsSupported(supported);
      const platform = await isPlatformAuthenticatorAvailable();
      if (!cancelled && mountedRef.current) setHasPlatformAuthenticator(platform);
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  const setBusy = useCallback((key: ActionKey, value: boolean): void => {
    busyRef.current[key] = value;
    if (key === 'signIn') setIsSigningIn(value);
    else if (key === 'register') setIsRegistering(value);
    else if (key === 'stepUp') setIsSteppingUp(value);
    else if (key === 'list') setIsLoading(value);
    else setIsMutating(value);
  }, []);

  /**
   * The session guard: signed-out, or a token we cannot obtain, is answered locally with zero
   * network calls. A passkey call made without a session would come back as an opaque server 401
   * the caller cannot distinguish from a step-up demand.
   */
  const requireSession = useCallback(async (): Promise<Session | PasskeyError> => {
    const expired = (): PasskeyError =>
      passkeyError('PASSKEY_SESSION_EXPIRED', 'you must be signed in to manage passkeys');
    if (!auth.isLoaded || !auth.isSignedIn) return expired();

    const token = await auth.getToken();
    if (!token.ok) {
      return token.error.code === 'NETWORK_ERROR'
        ? passkeyError('PASSKEY_NETWORK_ERROR', token.error.message)
        : expired();
    }
    return { accessToken: token.token, userId: auth.userId };
  }, [auth]);

  /**
   * One lifecycle for every action: re-entrancy guard → clear the previous error → busy flag →
   * abort controller → run → record the outcome → release.
   */
  const runAction = useCallback(
    async <T extends ResultLike>(
      key: ActionKey,
      guarded: T,
      run: (signal: AbortSignal) => Promise<T>,
      onSuccess?: (result: T) => void,
    ): Promise<T> => {
      if (busyRef.current[key]) return guarded;
      if (CEREMONY_ACTIONS.has(key) && isCeremonyBusy(busyRef.current)) return guarded;

      setBusy(key, true);
      setError(null);
      const controller = new AbortController();
      inFlightRef.current.add(controller);
      try {
        const result = await run(controller.signal);
        if (!result.ok && mountedRef.current) setError(result.error);
        if (result.ok && mountedRef.current) onSuccess?.(result);
        return result;
      } finally {
        inFlightRef.current.delete(controller);
        busyRef.current[key] = false;
        if (mountedRef.current) setBusy(key, false);
      }
    },
    [setBusy],
  );

  const busyError = useCallback(
    (action: string): { ok: false; error: PasskeyError } => ({
      ok: false,
      error: passkeyError('PASSKEY_INVALID_INPUT', `a passkey ${action} is already in progress`),
    }),
    [],
  );

  const sessionFailure = (session: Session | PasskeyError): session is PasskeyError =>
    !('accessToken' in session);

  const signInWithPasskey = useCallback(
    (input: SignInWithPasskeyInput = {}): Promise<AssertPasskeyResult> =>
      runAction<AssertPasskeyResult>('signIn', busyError('sign-in'), async (signal) => {
        const result = await assertPasskey({
          http,
          baseUrl: internals.baseUrl,
          clientId: internals.clientId,
          adapter,
          userHandle: input.userHandle,
          signal,
        });
        if (!result.ok) return result;

        const tokens: OAuthTokenResponse = result.tokens;
        try {
          await internals.completeSignIn(tokens);
        } catch (err) {
          return {
            ok: false,
            error: passkeyError(
              'PASSKEY_REQUEST_FAILED',
              `the passkey was accepted but the session could not be stored: ${
                err instanceof Error ? err.message : 'unknown error'
              }`,
            ),
          };
        }
        return result;
      }),
    [adapter, busyError, http, internals, runAction],
  );

  const stepUpWithPasskey = useCallback(
    (): Promise<StepUpWithPasskeyResult> =>
      runAction<StepUpWithPasskeyResult>('stepUp', busyError('step-up'), async (signal) => {
        const session = await requireSession();
        if (sessionFailure(session)) return { ok: false, error: session };
        return stepUpWithPasskeyCore({
          http,
          baseUrl: internals.baseUrl,
          clientId: internals.clientId,
          accessToken: session.accessToken,
          adapter,
          signal,
        });
      }),
    [adapter, busyError, http, internals, requireSession, runAction],
  );

  const registerPasskey = useCallback(
    (input: RegisterPasskeyHookInput): Promise<RegisterPasskeyResult> =>
      runAction<RegisterPasskeyResult>('register', busyError('registration'), async (signal) => {
        const session = await requireSession();
        if (sessionFailure(session)) return { ok: false, error: session };
        return registerPasskeyCore({
          http,
          baseUrl: internals.baseUrl,
          clientId: internals.clientId,
          accessToken: session.accessToken,
          stepUpToken: input.stepUpToken,
          adapter,
          nickname: input.nickname,
          signal,
        });
      }),
    [adapter, busyError, http, internals, requireSession, runAction],
  );

  const listPasskeys = useCallback(
    (input: ListPasskeysHookInput): Promise<ListPasskeysResult> =>
      runAction<ListPasskeysResult>(
        'list',
        busyError('list'),
        async (signal) => {
          const session = await requireSession();
          if (sessionFailure(session)) return { ok: false, error: session };
          return listPasskeysCore({
            http,
            baseUrl: internals.baseUrl,
            clientId: internals.clientId,
            accessToken: session.accessToken,
            stepUpToken: input.stepUpToken,
            userId: session.userId,
            signal,
          });
        },
        (result) => {
          if (result.ok) setPasskeys(result.data);
        },
      ),
    [busyError, http, internals, requireSession, runAction],
  );

  const renamePasskey = useCallback(
    (input: RenamePasskeyHookInput): Promise<PasskeySummaryResult> =>
      runAction<PasskeySummaryResult>(
        'mutate',
        busyError('mutation'),
        async (signal) => {
          const session = await requireSession();
          if (sessionFailure(session)) return { ok: false, error: session };
          return renamePasskeyCore({
            http,
            baseUrl: internals.baseUrl,
            clientId: internals.clientId,
            accessToken: session.accessToken,
            stepUpToken: input.stepUpToken,
            userId: session.userId,
            passkeyId: input.passkeyId,
            nickname: input.nickname,
            signal,
          });
        },
        (result) => {
          if (!result.ok) return;
          setPasskeys((current) =>
            current?.map((passkey) =>
              passkey.id === result.passkey.id ? result.passkey : passkey,
            ),
          );
        },
      ),
    [busyError, http, internals, requireSession, runAction],
  );

  const deletePasskey = useCallback(
    (input: DeletePasskeyHookInput): Promise<DeletePasskeyResult> =>
      runAction<DeletePasskeyResult>(
        'mutate',
        busyError('mutation'),
        async (signal) => {
          const session = await requireSession();
          if (sessionFailure(session)) return { ok: false, error: session };
          return deletePasskeyCore({
            http,
            baseUrl: internals.baseUrl,
            clientId: internals.clientId,
            accessToken: session.accessToken,
            stepUpToken: input.stepUpToken,
            userId: session.userId,
            passkeyId: input.passkeyId,
            signal,
          });
        },
        (result) => {
          if (result.ok) {
            setPasskeys((current) =>
              current?.filter((passkey) => passkey.id !== input.passkeyId),
            );
          }
        },
      ),
    [busyError, http, internals, requireSession, runAction],
  );

  return {
    isSupported,
    hasPlatformAuthenticator,
    passkeys,
    error,
    isSigningIn,
    isRegistering,
    isSteppingUp,
    isLoading,
    isMutating,
    signInWithPasskey,
    stepUpWithPasskey,
    registerPasskey,
    listPasskeys,
    renamePasskey,
    deletePasskey,
  };
}
