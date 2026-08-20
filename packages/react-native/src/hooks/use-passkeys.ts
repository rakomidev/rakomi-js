'use client';

/**
 * `usePasskeys` — passkey sign-in, step-up and management for React Native.
 *
 * Surface parity with `@rakomi/react`'s hook is deliberate: the same names, the same result shapes,
 * the same error codes, so a team shipping both a web app and a mobile app writes the same call sites.
 * The BEHAVIOUR differs in three places, each forced by the platform, and each is the reason a
 * copy-paste of the web hook would have been wrong:
 *
 * 1. **The session write is CONFIRMED, not assumed.** `@rakomi/react` calls `completeSignIn(tokens)`,
 *    which throws on failure. React Native has no such call: the provider exposes
 *    `submitOAuthTokens(tokens, nonce)`, which returns `Promise<void>` and **silently returns without
 *    persisting anything** when the nonce fails its CSRF check — it dispatches a `SIGN_IN_FAILED`
 *    event and resolves. `await` is therefore NOT proof of a session. The hook confirms by reading the
 *    token runtime back (`getToken()`), and compares the token AND the decoded user id. Without that,
 *    `signInWithPasskey()` returns `ok: true` to a user who is, in fact, still signed out.
 *
 * 2. **The ceremony lock is provider-scoped**, not hook-scoped. The passkey sheet is an OS-global
 *    modal — see `internal/ceremony-lock.ts`.
 *
 * 3. **The web-only adapter is absent.** There is no `createBrowserPasskeyAdapter()` fallback here; a
 *    native ceremony adapter is supplied by the host on `nativeAdapter.passkeys` (or injected for
 *    tests). If it is absent the hook is fail-closed: `isSupported: false`, and every action returns a
 *    terminal `PASSKEY_NOT_SUPPORTED` — never a silent no-op, and never an optimistic `true`.
 *
 * ## Bearer, not DPoP
 *
 * The passkey legs authenticate with a **Bearer** access token. If you have enabled DPoP for this
 * app, the passkey management calls are the one family that does not present a proof — they are
 * bearer-authenticated like the rest of the `/v1/passkeys/*` surface. Treat a leaked passkey access
 * token with the same seriousness as any bearer credential (RFC 6750 §5.3: it is a bearer secret; do
 * not log it, do not put it in a URL).
 *
 * ## What this hook never does
 *
 * It holds no storage handle of its own: it never writes a credential, a user handle or a challenge
 * anywhere. It does not follow that "no token is persisted" — a successful `signInWithPasskey` hands the
 * tokens to the provider's token runtime, which persists the REFRESH token to encrypted device storage
 * exactly as any other sign-in does. Saying otherwise would be a comfortable half-truth in a file that
 * ships as a published `.d.ts`.
 *
 * It never retries automatically: `nextAction: 'retry'` on an error is a signal for YOUR UI to offer a
 * retry, not a contract that the SDK will retry for you. And it never reports a capability it has not
 * probed — `isSupported` and `hasPlatformAuthenticator` are `null` until their probes resolve.
 *
 * ## Accessibility obligation (yours, not ours)
 *
 * While a ceremony is open, the OS sheet owns the screen. The hook exposes `isSigningIn` /
 * `isRegistering` / `isSteppingUp` so you can mark your own controls busy and disabled — a second tap
 * during a ceremony is answered locally with `PASSKEY_INVALID_INPUT` and never reaches the OS, but a
 * button that still looks tappable is a button a screen-reader user will tap.
 *
 * **The busy flags are PER HOOK INSTANCE.** They tell you about your component's call, not about another
 * component's. Two `usePasskeys()` instances (a header sign-in button and a settings screen) contend for
 * one OS-global sheet: the provider-scoped lock refuses the second ceremony, and the refusal lands in
 * that hook's `error` — but its `isSigningIn` stays `false`, because *it* is not the one that is busy.
 * If two entry points can be on screen together, drive them from ONE `usePasskeys()` instance.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  assertPasskey,
  type AssertPasskeyResult,
  decodeJwtPayload,
  decodeUser,
  deletePasskey as deletePasskeyCore,
  type DeletePasskeyResult,
  listPasskeys as listPasskeysCore,
  type ListPasskeysResult,
  type OAuthTokenResponse,
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

import { useRakomiContext } from '../context.js';

export interface UsePasskeysOptions {
  /**
   * Override the ceremony adapter. Intended for tests (`createFakePasskeyAdapter()` from
   * `@rakomi/sdk-core/passkeys/testing`) and for a host that builds its adapter outside the provider.
   * When omitted, the adapter comes from `nativeAdapter.passkeys`.
   */
  adapter?: PasskeyCeremonyAdapter;
}

export interface SignInWithPasskeyInput {
  /**
   * Identified sign-in. **An opaque, server-issued handle — NOT an email, NOT a username.** The type is
   * branded (`OpaqueUserHandle`), so a raw string will not compile: passing a user-typed identifier here
   * turns a usernameless flow into an account-enumeration oracle, and — because platform passkeys sync
   * across a user's devices — can reveal which of their devices hold a credential. Omit it for the
   * usernameless flow, which is what almost every app wants.
   */
  userHandle?: OpaqueUserHandle;
}

export interface RegisterPasskeyHookInput {
  /** Minted by `stepUpWithPasskey()` or by the password step-up endpoint. */
  stepUpToken: string;
  nickname?: string;
}

export interface ListPasskeysHookInput {
  stepUpToken: string;
}

export interface RenamePasskeyHookInput {
  stepUpToken: string;
  passkeyId: string;
  nickname: string;
}

export interface DeletePasskeyHookInput {
  stepUpToken: string;
  passkeyId: string;
}

export interface UsePasskeysResult {
  /** `null` until the capability probe resolves. `false` means this device cannot run a ceremony. */
  isSupported: boolean | null;
  /** `null` until probed, and `null` also means UNKNOWN (a module that cannot answer). A UI hint for
   * wording ("Sign in with Face ID"), never a gate. */
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

/** The actions that open the OS sheet. They contend for ONE system-global modal. */
const CEREMONY_ACTIONS: ReadonlySet<ActionKey> = new Set<ActionKey>(['signIn', 'register', 'stepUp']);

type ResultLike = { ok: true } | { ok: false; error: PasskeyError };

interface Session {
  accessToken: string;
  userId: string;
}

/**
 * The platform-authenticator hint is a NATIVE-only capability: sdk-core's `PasskeyCeremonyAdapter` has
 * no place for it (a browser answers it through a static WebAuthn call, not through the adapter). The
 * native adapter attaches it; a hand-rolled or injected test adapter need not, and then the hook
 * reports `null` — UNKNOWN — rather than guessing.
 */
function platformProbe(
  adapter: PasskeyCeremonyAdapter,
): (() => Promise<boolean | null>) | undefined {
  const candidate = (adapter as { hasPlatformAuthenticator?: unknown }).hasPlatformAuthenticator;
  return typeof candidate === 'function'
    ? (candidate as () => Promise<boolean | null>).bind(adapter)
    : undefined;
}

/**
 * The two claims that identify a SESSION: who it belongs to, and which session it is.
 *
 * `sid` is the load-bearing half. Without it, a rejected token submission that left a PREVIOUS session
 * for the SAME user in place would look identical to a successful one — the subject would match. With
 * it, only the session this ceremony actually minted satisfies the confirmation.
 */
function sessionIdentity(token: string): { subject: string; session: string } | null {
  const payload = decodeJwtPayload(token);
  if (payload === null) return null;
  const subject = payload['sub'];
  const session = payload['sid'];
  if (typeof subject !== 'string' || !subject) return null;
  if (typeof session !== 'string' || !session) return null;
  return { subject, session };
}

const notSupported = (): PasskeyError =>
  passkeyError(
    'PASSKEY_NOT_SUPPORTED',
    'no passkey ceremony adapter is wired: pass one on `nativeAdapter.passkeys` (see createNativePasskeyAdapter)',
  );

export function usePasskeys(options: UsePasskeysOptions = {}): UsePasskeysResult {
  const ctx = useRakomiContext();
  const {
    adapter: nativeAdapter,
    http,
    baseUrl,
    publishableKey,
    getToken,
    beginAuthFlow,
    submitOAuthTokens,
    passkeyCeremonyLock,
  } = ctx;

  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [hasPlatformAuthenticator, setHasPlatformAuthenticator] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | undefined>(undefined);
  const [error, setError] = useState<PasskeyError | null>(null);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [isRegistering, setIsRegistering] = useState<boolean>(false);
  const [isSteppingUp, setIsSteppingUp] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isMutating, setIsMutating] = useState<boolean>(false);

  const adapter: PasskeyCeremonyAdapter | undefined = options.adapter ?? nativeAdapter.passkeys;

  const mountedRef = useRef<boolean>(true);
  /**
   * Re-entrancy is tracked in a ref, not in the busy STATE: a second tap lands in the same React
   * batch as the first, where the state has not updated yet, and a stale-closure read would let it
   * through — straight into a second OS sheet.
   */
  const busyRef = useRef<Record<ActionKey, boolean>>({
    signIn: false,
    register: false,
    stepUp: false,
    list: false,
    mutate: false,
  });
  /**
   * Every in-flight action's controller. Unmounting aborts them all — which cancels the ceremony and
   * the HTTP leg, not merely the `setState` that would have followed. Without it, an unmounted
   * registration still mints a server-side credential no UI ever confirmed, and an abandoned step-up
   * mints a replay-capable token nobody reads.
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

  /**
   * The only thing that happens on mount: two capability probes, and ZERO network calls. Keyed on the
   * ADAPTER, not on the context object — the context value is rebuilt on every token refresh, and
   * keying on it would re-probe (and, on some modules, re-prompt) on every background refresh.
   */
  useEffect(() => {
    if (adapter === undefined) {
      setIsSupported(false);
      setHasPlatformAuthenticator(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [supported, platform] = await Promise.all([
        Promise.resolve(adapter.isSupported()).catch(() => false),
        Promise.resolve(platformProbe(adapter)?.() ?? null).catch(() => null),
      ]);
      if (cancelled || !mountedRef.current) return;
      setIsSupported(supported === true);
      setHasPlatformAuthenticator(typeof platform === 'boolean' ? platform : null);
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
   * The session guard. A signed-out caller, or a token we cannot obtain, is answered locally with zero
   * network calls: a passkey call made without a session comes back as an opaque 401 the caller cannot
   * distinguish from a step-up demand.
   *
   * KNOWN COARSENESS, pinned by a test so a future fix shows up as a RED test of intent: the RN token
   * runtime flattens its failure reasons, so a `getToken()` that failed on the NETWORK is reported here
   * as `PASSKEY_SESSION_EXPIRED` (terminal, "re-authenticate") rather than as a retryable network
   * error. `@rakomi/react` can tell the two apart and does. That means a live session can be reported
   * as expired when the phone is briefly offline. It is the honest reading of what the runtime tells
   * us — inventing a network error we cannot see would be worse — and the fix belongs in the runtime.
   */
  const requireSession = useCallback(async (): Promise<Session | PasskeyError> => {
    const expired = (): PasskeyError =>
      passkeyError('PASSKEY_SESSION_EXPIRED', 'you must be signed in to manage passkeys');

    const token = await getToken();
    if (!token.ok) {
      const err = token.error;
      if (err.code === 'NETWORK_ERROR' || (err.code === 'REFRESH_FAILED' && err.reason === 'network')) {
        return passkeyError('PASSKEY_NETWORK_ERROR', err.message);
      }
      return expired();
    }

    const user = decodeUser(token.token);
    if (user === null) return expired();
    return { accessToken: token.token, userId: user.id };
  }, [getToken]);

  /**
   * One lifecycle for every action: adapter gate → re-entrancy guard → ceremony lock → busy flag →
   * abort controller → run → record → release. The release is in a `finally` so a THROW (not merely a
   * failed result) cannot strand the provider-scoped lock and wedge every future ceremony.
   */
  const runAction = useCallback(
    async <T extends ResultLike>(
      key: ActionKey,
      guarded: T,
      run: (signal: AbortSignal) => Promise<T>,
      onSuccess?: (result: T) => void,
    ): Promise<T> => {
      const refuse = (result: T): T => {
        if (!result.ok && mountedRef.current) setError(result.error);
        return result;
      };

      if (busyRef.current[key]) return refuse(guarded);

      const isCeremony = CEREMONY_ACTIONS.has(key);
      if (isCeremony && !passkeyCeremonyLock.tryAcquire()) return refuse(guarded);

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
        if (isCeremony) passkeyCeremonyLock.release();
        if (mountedRef.current) setBusy(key, false);
      }
    },
    [passkeyCeremonyLock, setBusy],
  );

  const busyResult = useCallback(
    (action: string): { ok: false; error: PasskeyError } => ({
      ok: false,
      error: passkeyError('PASSKEY_INVALID_INPUT', `a passkey ${action} is already in progress`),
    }),
    [],
  );

  /**
   * No adapter wired ⇒ every action fails closed with a terminal `PASSKEY_NOT_SUPPORTED`, zero network
   * calls — and, like every other failure, it lands in `error` so the UI has something to render. An
   * earlier version returned the result without touching the state, so an app that renders `error`
   * showed nothing at all on the one failure that is guaranteed to happen in Expo Go.
   */
  const unsupported = useCallback(<T extends ResultLike>(): Promise<T> => {
    const result = { ok: false as const, error: notSupported() };
    if (mountedRef.current) setError(result.error);
    return Promise.resolve(result as unknown as T);
  }, []);

  const sessionFailure = (session: Session | PasskeyError): session is PasskeyError =>
    !('accessToken' in session);

  /**
   * Sign in, then CONFIRM the session actually exists.
   *
   * The confirmation is the whole point. `submitOAuthTokens` resolves without persisting anything when
   * its CSRF nonce check fails, so awaiting it proves nothing. We read the token runtime back and
   * require three things: the read succeeded, it returned the SAME access token we just submitted, and
   * it decodes to the same user. The third check is what catches the cross-user case — signing in as B
   * while A's session is live must not report success against A's still-current token.
   */
  const signInWithPasskey = useCallback(
    (input: SignInWithPasskeyInput = {}): Promise<AssertPasskeyResult> => {
      if (adapter === undefined) return unsupported();
      return runAction<AssertPasskeyResult>('signIn', busyResult('sign-in'), async (signal) => {
        const result = await assertPasskey({
          http,
          baseUrl,
          clientId: publishableKey,
          adapter,
          ...(input.userHandle === undefined ? {} : { userHandle: input.userHandle }),
          signal,
        });
        if (!result.ok) return result;

        const failed = (message: string): AssertPasskeyResult => ({
          ok: false,
          error: passkeyError('PASSKEY_REQUEST_FAILED', message),
        });

        let nonce: string;
        try {
          nonce = await beginAuthFlow();
        } catch (err) {
          return failed(
            `the passkey was accepted but the session could not be started: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }

        const tokens: OAuthTokenResponse = result.tokens;

        if (nativeAdapter.dpopProver !== undefined && tokens.token_type !== 'DPoP') {
          return failed(
            'the passkey was accepted but the session was refused: this app is configured for sender-constrained (DPoP) sessions, and the passkey sign-in returned an unbound bearer session. Storing it would silently downgrade the app\u2019s security posture.',
          );
        }

        try {
          await submitOAuthTokens(tokens, nonce);
        } catch (err) {
          return failed(
            `the passkey was accepted but the session could not be stored: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }

        const confirmed = await getToken();
        if (!confirmed.ok) {
          return failed(
            'the passkey was accepted but the session was not established (the token submission was rejected)',
          );
        }

        const submitted = sessionIdentity(tokens.access_token);
        const live = sessionIdentity(confirmed.token);
        if (submitted === null || live === null) {
          if (confirmed.token !== tokens.access_token) {
            return failed('the passkey was accepted but the resulting session token could not be read');
          }
          return result;
        }
        if (live.subject !== submitted.subject || live.session !== submitted.session) {
          return failed(
            'the passkey was accepted but the session was not established (the token submission was rejected)',
          );
        }
        return result;
      });
    },
    [
      adapter,
      baseUrl,
      beginAuthFlow,
      busyResult,
      getToken,
      http,
      publishableKey,
      runAction,
      submitOAuthTokens,
      unsupported,
    ],
  );

  const stepUpWithPasskey = useCallback((): Promise<StepUpWithPasskeyResult> => {
    if (adapter === undefined) return unsupported();
    return runAction<StepUpWithPasskeyResult>('stepUp', busyResult('step-up'), async (signal) => {
      const session = await requireSession();
      if (sessionFailure(session)) return { ok: false, error: session };
      return stepUpWithPasskeyCore({
        http,
        baseUrl,
        clientId: publishableKey,
        accessToken: session.accessToken,
        adapter,
        signal,
      });
    });
  }, [adapter, baseUrl, busyResult, http, publishableKey, requireSession, runAction, unsupported]);

  const registerPasskey = useCallback(
    (input: RegisterPasskeyHookInput): Promise<RegisterPasskeyResult> => {
      if (adapter === undefined) return unsupported();
      return runAction<RegisterPasskeyResult>('register', busyResult('registration'), async (signal) => {
        const session = await requireSession();
        if (sessionFailure(session)) return { ok: false, error: session };
        return registerPasskeyCore({
          http,
          baseUrl,
          clientId: publishableKey,
          accessToken: session.accessToken,
          stepUpToken: input.stepUpToken,
          adapter,
          ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
          signal,
        });
      });
    },
    [adapter, baseUrl, busyResult, http, publishableKey, requireSession, runAction, unsupported],
  );

  const listPasskeys = useCallback(
    (input: ListPasskeysHookInput): Promise<ListPasskeysResult> =>
      runAction<ListPasskeysResult>(
        'list',
        busyResult('list'),
        async (signal) => {
          const session = await requireSession();
          if (sessionFailure(session)) return { ok: false, error: session };
          return listPasskeysCore({
            http,
            baseUrl,
            clientId: publishableKey,
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
    [baseUrl, busyResult, http, publishableKey, requireSession, runAction],
  );

  const renamePasskey = useCallback(
    (input: RenamePasskeyHookInput): Promise<PasskeySummaryResult> =>
      runAction<PasskeySummaryResult>(
        'mutate',
        busyResult('mutation'),
        async (signal) => {
          const session = await requireSession();
          if (sessionFailure(session)) return { ok: false, error: session };
          return renamePasskeyCore({
            http,
            baseUrl,
            clientId: publishableKey,
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
            current?.map((passkey) => (passkey.id === result.passkey.id ? result.passkey : passkey)),
          );
        },
      ),
    [baseUrl, busyResult, http, publishableKey, requireSession, runAction],
  );

  const deletePasskey = useCallback(
    (input: DeletePasskeyHookInput): Promise<DeletePasskeyResult> =>
      runAction<DeletePasskeyResult>(
        'mutate',
        busyResult('mutation'),
        async (signal) => {
          const session = await requireSession();
          if (sessionFailure(session)) return { ok: false, error: session };
          return deletePasskeyCore({
            http,
            baseUrl,
            clientId: publishableKey,
            accessToken: session.accessToken,
            stepUpToken: input.stepUpToken,
            userId: session.userId,
            passkeyId: input.passkeyId,
            signal,
          });
        },
        (result) => {
          if (result.ok) {
            setPasskeys((current) => current?.filter((passkey) => passkey.id !== input.passkeyId));
          }
        },
      ),
    [baseUrl, busyResult, http, publishableKey, requireSession, runAction],
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
