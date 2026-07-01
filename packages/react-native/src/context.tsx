/**
 * `<RakomiProvider>` — RN context provider.
 *
 * Owns:
 * - The frozen `NativeAuthAdapter`.
 * - The auth-machine snapshot (`@rakomi/sdk-core` `MachineSnapshot`).
 * - The HTTP client.
 * - The `TokenRuntime` — drives the FSM, manages refresh + storage.
 * - Deep-link callback subscription (single-use, idempotent).
 * - AppState listener (debounced 300ms) for
 * foreground refresh, with single in-flight Promise dedup.
 * - Network connectivity listener for online/offline transitions.
 *
 * Hooks read from this context — they're thin wrappers.
 */

'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';

import type {
  AuthEvent,
  AuthMachineState,
  HttpClient,
  Locale,
  MachineAction,
  MachineSnapshot,
  OAuthTokenResponse,
  TokenResult,
  Translations,
  UserResource,
} from '@rakomi/sdk-core';
import {
  createTranslator,
  EventLog,
  INITIAL_SNAPSHOT,
  isSignedIn as projectionIsSignedIn,
  reduce,
} from '@rakomi/sdk-core';

import { createDpopSession, type DpopSession } from './internal/dpop-session.js';
import { createRnHttpClient } from './internal/http-client.js';
import { TokenRuntime } from './internal/token-runtime.js';
import { createDefaultExpoAdapter } from './native/expo-adapter.js';
import type { NativeAuthAdapter, TokenCache } from './native/types.js';

export interface RakomiProviderProps {
  /** Tenant publishable key — used to derive base URL + tenant ID. */
  publishableKey: string;
  /** API base URL. Required if `publishableKey` is dev/local. */
  baseUrl?: string;
  /** Custom URL scheme for OAuth callback (RFC 8252). Reverse-DNS recommended. */
  redirectUri: string;
  /** Override the default Expo adapter. Bare-RN consumers MUST supply this. */
  nativeAdapter?: NativeAuthAdapter;
  /** Sugar override: replace only storage in the default adapter. */
  tokenCache?: TokenCache;
  /** Enable biometric gate before reading refresh tokens. */
  biometric?: boolean;
  /** When `biometric: true`, disable device passcode fallback. Default false. */
  biometricStrict?: boolean;
  /** Localized prompt for biometric reads. */
  biometricPrompt?: string;
  /** iOS ephemeral session toggle. Default true. */
  browserPreferEphemeralSession?: boolean;
  /** JWKS TTL ceiling (≤7 days). Default 24h. */
  offlineMaxAgeSeconds?: number;
  /** opt-out of automatic deep-link handling. */
  deepLinkAutoHandle?: boolean;
  /** Typed event bus. Consumer wires telemetry. */
  onEvent?: (event: AuthEvent) => void;
  /** i18n locale. Default 'en'. */
  locale?: Locale;
  /** Translation overrides — merged onto locale dictionary. */
  translations?: Partial<Translations>;
  /** Override the OAuth token endpoint. Default: `<baseUrl>/oauth/token`. */
  tokenEndpoint?: string;
  /** Tenant identifier for storage-key derivation. Defaults to `publishableKey`. */
  tenantId?: string;
  children: ReactNode;
}

interface RakomiContextValue {
  publishableKey: string;
  baseUrl: string;
  redirectUri: string;
  adapter: NativeAuthAdapter;
  http: HttpClient;
  snapshot: MachineSnapshot;
  state: AuthMachineState;
  isSignedIn: boolean;
  user: UserResource | null;
  events: EventLog;
  locale: Locale;
  translate: ReturnType<typeof createTranslator>;
  dispatch: (action: MachineAction) => void;
  /** Sign-out helper — clears storage + dispatches. */
  signOut: () => Promise<void>;
  /** `useAuth().getToken` delegates here — reads in-memory access token, refreshes if stale. */
  getToken: () => Promise<TokenResult>;
  /**
 * Issue a one-time submit nonce — required to call `submitOAuthTokens`.
 * gates the consumer-facing tokens-write surface.
 */
  beginAuthFlow: () => Promise<string>;
  /**
 * Submit OAuth tokens after `startSocialSignIn` (or password / magic-link / email-OTP) completes.
 * Persists refresh token, decodes user/session, dispatches `SIGN_IN_SUCCESS`.
 *
 * requires a `nonce` previously issued by `beginAuthFlow`. Without it,
 * the runtime dispatches `SIGN_IN_FAILED` with `CSRF_MISMATCH` and the tokens are NOT persisted.
 */
  submitOAuthTokens: (tokens: OAuthTokenResponse, nonce: string) => Promise<void>;
  /**
 * Session-scoped DPoP binding handle,
 * auto-constructed when the adapter exposes a `dpopProver`. Pass it to
 * `startSocialSignIn({ dpopSession })` so a proof is attached at issuance
 * — the SAME handle is wired into the runtime, so every refresh
 * re-presents the bound key. `undefined` when the adapter has no native prover.
 */
  dpopSession?: DpopSession;
}

const RakomiContext = createContext<RakomiContextValue | null>(null);

const APP_STATE_DEBOUNCE_MS = 300;

export function RakomiProvider(props: RakomiProviderProps): ReactNode {
  const adapter = useMemo<NativeAuthAdapter>(() => {
    const built = props.nativeAdapter ?? createDefaultExpoAdapter({ tokenCache: props.tokenCache });
    return Object.freeze(built);
  }, [props.nativeAdapter, props.tokenCache]);

  const http = useMemo(() => createRnHttpClient({ baseUrl: props.baseUrl }), [props.baseUrl]);

  const events = useMemo(() => new EventLog(props.onEvent), [props.onEvent]);

  const [snapshot, dispatch] = useReducer(reduce, INITIAL_SNAPSHOT);

  const translate = useMemo(
    () => createTranslator(props.locale ?? 'en', props.translations),
    [props.locale, props.translations],
  );

  const dpopSession = useMemo<DpopSession | undefined>(() => {
    if (!adapter.dpopProver) return undefined;
    return createDpopSession({
      prover: adapter.dpopProver,
      baseUrl: props.baseUrl ?? '',
      onDowngrade: () => {
        events.push({ type: 'sign_in_failed', severity: 'security', metadata: { reason: 'dpop_downgrade' } });
      },
    });
  }, [adapter, props.baseUrl, events]);

  const runtime = useMemo(() => {
    const tokenEndpoint = props.tokenEndpoint
      ?? `${(props.baseUrl ?? '').replace(/\/$/, '')}/oauth/token`;
    return new TokenRuntime({
      clientId: props.publishableKey,
      tenantId: props.tenantId ?? props.publishableKey,
      tokenEndpoint,
      storage: adapter.storage,
      http,
      crypto: adapter.crypto,
      biometric: adapter.biometric,
      biometricEnabled: props.biometric ?? false,
      biometricStrict: props.biometricStrict ?? false,
      biometricPrompt: props.biometricPrompt ?? 'Authenticate to continue',
      dispatch,
      dpopSession,
      onEvent: ({ type, metadata }) => {
        if (type === 'biometric_failed') {
          events.push({ type: 'biometric_failed', severity: 'warning', metadata });
        } else if (type === 'network_retry') {
          events.push({ type: 'network_retry', severity: 'warning', metadata });
        } else if (type === 'refresh_started') {
          events.push({ type: 'refresh_started', severity: 'info', metadata });
        } else if (type === 'refresh_succeeded') {
          events.push({ type: 'refresh_succeeded', severity: 'info', metadata });
        } else if (type === 'refresh_failed') {
          events.push({ type: 'refresh_failed', severity: 'warning', metadata });
        }
      },
    });
  }, [adapter, http, props.publishableKey, props.tenantId, props.baseUrl, props.tokenEndpoint, props.biometric, props.biometricStrict, props.biometricPrompt, events, dpopSession]);

  useEffect(() => {
    void runtime.restore();
    return () => runtime.destroy();
  }, [runtime]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const sub = adapter.appLifecycle.addStateChangeListener((next) => {
      if (next !== 'active') return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        events.push({ type: 'app_state_foreground', severity: 'info' });
        void runtime.refreshOnForeground();
      }, APP_STATE_DEBOUNCE_MS);
    });
    return () => {
      sub.remove();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [adapter, events, runtime]);

  useEffect(() => {
    const bg = adapter.backgroundTask;
    if (!bg) return undefined;
    let unregister: (() => Promise<void>) | null = null;
    void (async () => {
      try {
        const ok = await bg.isAvailable();
        if (!ok) return;
        unregister = await bg.register(async () => {
          await runtime.refreshOnForeground();
        });
      } catch {
      }
    })();
    return () => {
      if (unregister) void unregister().catch(() => undefined);
    };
  }, [adapter, runtime]);

  useEffect(() => {
    const sub = adapter.connectivity.addListener((isConnected) => {
      if (isConnected) {
        events.push({ type: 'offline_queue_drained', severity: 'info' });
        dispatch({ type: 'BACK_ONLINE' });
        void runtime.refreshOnForeground();
      } else {
        dispatch({ type: 'OFFLINE_STALE' });
      }
    });
    return () => sub.remove();
  }, [adapter, events, runtime]);

  useEffect(() => {
    if (props.deepLinkAutoHandle === false) return undefined;
    const sub = adapter.deepLink.addListener(() => {
      events.push({ type: 'deep_link_received', severity: 'info' });
    });
    void adapter.deepLink.getInitialUrl().then((url) => {
      if (url) {
        events.push({ type: 'deep_link_received', severity: 'info', metadata: { coldStart: true } });
      }
    }).catch(() => undefined);
    return () => sub.remove();
  }, [adapter, events, props.deepLinkAutoHandle]);

  const signOut = useMemo(
    () => async () => {
      events.push({ type: 'signed_out', severity: 'info' });
      await runtime.clear();
    },
    [events, runtime],
  );

  const getToken = useMemo(() => () => runtime.getToken(), [runtime]);

  const submitOAuthTokens = useMemo(
    () => async (tokens: OAuthTokenResponse, nonce: string) => {
      if (!runtime.validateSubmitNonce(nonce)) {
        events.push({ type: 'sign_in_failed', severity: 'security', error: { code: 'CSRF_MISMATCH', message: 'Submit nonce missing or expired' } });
        dispatch({ type: 'SIGN_IN_FAILED', error: { code: 'CSRF_MISMATCH', message: 'Submit nonce missing or expired' } });
        return;
      }
      await runtime.setTokens(tokens, 'sign_in');
    },
    [runtime, events],
  );

  const beginAuthFlow = useMemo(() => () => runtime.beginAuthFlow(), [runtime]);

  const value = useMemo<RakomiContextValue>(
    () => ({
      publishableKey: props.publishableKey,
      baseUrl: props.baseUrl ?? '',
      redirectUri: props.redirectUri,
      adapter,
      http,
      snapshot,
      state: snapshot.state,
      isSignedIn: projectionIsSignedIn(snapshot),
      user: snapshot.user,
      events,
      locale: props.locale ?? 'en',
      translate,
      dispatch,
      signOut,
      getToken,
      submitOAuthTokens,
      beginAuthFlow,
      dpopSession,
    }),
    [adapter, http, snapshot, events, props.publishableKey, props.baseUrl, props.redirectUri, props.locale, translate, signOut, getToken, submitOAuthTokens, beginAuthFlow, dpopSession],
  );

  return <RakomiContext.Provider value={value}>{props.children}</RakomiContext.Provider>;
}

/** Internal hook — read the live RakomiContextValue. Throws if not inside a provider. */
export function useRakomiContext(): RakomiContextValue {
  const ctx = useContext(RakomiContext);
  if (!ctx) {
    throw new Error('useRakomi*() must be called inside a <RakomiProvider>.');
  }
  return ctx;
}
