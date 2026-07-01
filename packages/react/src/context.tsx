'use client';

/**
 * RakomiContext & RakomiProvider — React context for @rakomi/react.
 *
 * "use client" directive required for Next.js App Router.
 * All browser API access is guarded (typeof window !== 'undefined').
 *
 * Security invariants:
 * - baseUrl HTTPS validation (rejects http:// on non-localhost)
 * - returnTo MUST be a relative path (starts with '/') — prevents open redirect
 * - OAuth state validated BEFORE code exchange (CSRF protection)
 * - Code exchange is deduplicated via useRef StrictMode guard
 * - URL cleaned via replaceState BEFORE exchange (prevents replay on refresh)
 * - signOut: optimistic clear first, then best-effort /oauth/revoke
 * - credentials: 'omit' on all fetch calls
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import { AppearanceContext } from './appearance.js';
import { EventLog } from './event-log.js';
import { sdkFetch } from './lib/fetch-client.js';
import { anonymousSignIn } from './oauth/anonymous-signin.js';
import { AuthConfigManager } from './oauth/auth-config.js';
import { buildAuthorizeUrl } from './oauth/authorize.js';
import { directSignIn } from './oauth/direct-auth.js';
import { parseOAuthCallbackError } from './oauth/errors.js';
import { generatePKCE } from './oauth/pkce.js';
import { generateState } from './oauth/state.js';
import { exchangeCode } from './oauth/token.js';
import { resolveStorage } from './storage.js';
import { TabSync } from './tab-sync.js';
import { TokenManager } from './token-manager.js';
import type { AuthState, OAuthTokenResponse, RakomiProviderProps, SignInOptions, SignInResult } from './types.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';

/**
 * Internal context — provides baseUrl, clientId, redirectUrl, and completeSignIn to pre-built components.
 * Not part of public API — components access via useRakomiInternals() internal hook.
 */
export interface RakomiInternals {
  baseUrl: string;
  clientId: string;
  redirectUrl: string;
  completeSignIn: (tokens: OAuthTokenResponse) => Promise<void>;
  emitEvent: (event: Omit<import('./types.js').AuthEvent, 'timestamp' | 'tabId'>) => void;
  setPersistence: (persistence: 'session' | 'local') => Promise<void>;
  brandingOverride?: Partial<import('./types.js').BrandingConfig>;
}

function oauthStateKey(clientId: string): string {
  return `rakomi:${clientId}:oauth_state`;
}

/**
 * Constant-time string comparison — prevents timing side-channel on OAuth state.
 * JavaScript's === short-circuits on first mismatch, leaking partial timing information.
 * This implementation runs in O(n) regardless of where characters differ.
 */
function timeSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function getViteEnv(): Record<string, string> {
  try {
    return ((import.meta as unknown as { env?: Record<string, string> }).env) ?? {};
  } catch { return {}; }
}

function getNextEnv(): Record<string, string | undefined> {
  try {
    const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
    return g.process?.env ?? {};
  } catch { return {}; }
}

function getEnvClientId(): string | undefined {
  const vite = getViteEnv();
  if (vite['VITE_RAKOMI_CLIENT_ID']) return vite['VITE_RAKOMI_CLIENT_ID'];
  const next = getNextEnv();
  if (next['NEXT_PUBLIC_RAKOMI_CLIENT_ID']) return next['NEXT_PUBLIC_RAKOMI_CLIENT_ID'];
  return undefined;
}

function getEnvBaseUrl(): string | undefined {
  const vite = getViteEnv();
  if (vite['VITE_RAKOMI_BASE_URL']) return vite['VITE_RAKOMI_BASE_URL'];
  const next = getNextEnv();
  if (next['NEXT_PUBLIC_RAKOMI_BASE_URL']) return next['NEXT_PUBLIC_RAKOMI_BASE_URL'];
  return undefined;
}

export const RakomiContext = createContext<AuthState | undefined>(undefined);
export const AuthConfigManagerContext = createContext<AuthConfigManager | null>(null);
export const RakomiLocaleContext = createContext<
  'en' | 'pl' | 'de' | 'fr' | 'es' | undefined
>(undefined);
export const RakomiTranslationsContext = createContext<
  Partial<import('./i18n/types.js').Translations> | undefined
>(undefined);
export const RakomiColorSchemeContext = createContext<'light' | 'dark' | 'auto' | undefined>(undefined);
export const RakomiInternalsContext = createContext<RakomiInternals | null>(null);

export function RakomiProvider(props: RakomiProviderProps): React.ReactElement {
  const {
    children,
    persistence = 'session',
    storage: customStorage,
    initialState,
    onRedirectCallback,
    onAuthEvent,
    sessionTimeout,
    expiringThresholdMinutes,
  } = props;

  const clientId = props.clientId ?? getEnvClientId();
  const baseUrl = props.baseUrl ?? getEnvBaseUrl() ?? DEFAULT_BASE_URL;
  const redirectUrl =
    props.redirectUrl ??
    (typeof window !== 'undefined'
      ? `${window.location.origin}/oauth/callback`
      : undefined);

  const parentContext = useContext(RakomiContext);
  if (parentContext !== undefined && getNextEnv()['NODE_ENV'] !== 'production') {
    console.warn('[Rakomi] Nested <RakomiProvider> detected. Remove the inner provider.');
  }

  if (!clientId) {
    throw new Error(
      '[Rakomi] clientId is required. Pass it as a prop or set VITE_RAKOMI_CLIENT_ID / NEXT_PUBLIC_RAKOMI_CLIENT_ID.',
    );
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(clientId)) {
    throw new Error('[Rakomi] clientId contains invalid characters. Must match /^[a-zA-Z0-9_-]{1,128}$/.');
  }

  const tokenManagerRef = useRef<TokenManager | null>(null);
  const configManagerRef = useRef<AuthConfigManager | null>(null);

  if (tokenManagerRef.current === null) {
    const storage = resolveStorage(persistence, customStorage);
    const tabSync = new TabSync(clientId, persistence);
    const eventLog = new EventLog(onAuthEvent);

    tokenManagerRef.current = new TokenManager({
      clientId,
      baseUrl,
      storage,
      tabSync,
      eventLog,
      initialState,
      sessionTimeout,
      expiringThresholdMinutes,
    });
  }

  const tokenManager = tokenManagerRef.current;

  if (
    configManagerRef.current === null ||
    !configManagerRef.current.isSameConfig(clientId, baseUrl)
  ) {
    configManagerRef.current = new AuthConfigManager(clientId, baseUrl, clientId);
  }
  const configManager = configManagerRef.current;

  const authState = useSyncExternalStore(
    tokenManager.subscribe,
    tokenManager.getSnapshot,
    tokenManager.getServerSnapshot,
  );

  const codeExchangeStarted = useRef(false);
  const preflightStarted = useRef(false);

  useEffect(() => {
    const tm = tokenManagerRef.current!;

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);

      const code = url.searchParams.get('code');
      const stateParam = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');
      const errorDescription = (url.searchParams.get('error_description') ?? '').slice(0, 512);

      if (
        (code && code.length > 512) ||
        (stateParam && stateParam.length > 128) ||
        (errorParam && errorParam.length > 256)
      ) {
        cleanOAuthParams(url);
        return;
      }

      if (errorParam) {
        const authError = parseOAuthCallbackError(errorParam, errorDescription);
        cleanOAuthParams(url);
        void tm.clear(authError);
        return;
      }

      if (code && stateParam && !codeExchangeStarted.current) {
        codeExchangeStarted.current = true;

        void (async () => {
          const storedState = getSessionItem(oauthStateKey(clientId));

          if (!storedState || !/^[a-f0-9]{64}$/.test(storedState)) {
            cleanOAuthParams(url);
            removeSessionItem(oauthStateKey(clientId));
            tm['eventLog'].push({
              type: 'session_mismatch',
              severity: 'security',
              metadata: { reason: 'oauth_state_invalid_format' },
            });
            tm.setSignedOutWithError({ code: 'CSRF_MISMATCH', message: 'OAuth state has invalid format.' });
            return;
          }

          if (!timeSafeEqual(storedState, stateParam)) {
            cleanOAuthParams(url);
            removeSessionItem(oauthStateKey(clientId));
            tm['eventLog'].push({
              type: 'session_mismatch',
              severity: 'security',
              metadata: { reason: 'oauth_state_mismatch' },
            });
            tm.setSignedOutWithError({ code: 'CSRF_MISMATCH', message: 'OAuth state mismatch — possible CSRF attack.' });
            return;
          }

          removeSessionItem(oauthStateKey(clientId));

          const verifierKey = `rakomi:${clientId}:pkce_verifier`;
          const returnToKey = `rakomi:${clientId}:return_to`;
          const storedVerifier = getSessionItem(verifierKey);
          const returnTo = getSessionItem(returnToKey) ?? undefined;

          cleanOAuthParams(url);

          removeSessionItem(verifierKey);
          removeSessionItem(returnToKey);

          if (!storedVerifier || !redirectUrl) {
            const exchangeError = !storedVerifier
              ? { code: 'CODE_EXCHANGE_FAILED' as const, message: 'PKCE verifier missing — sessionStorage may be unavailable in this browser.' }
              : { code: 'CODE_EXCHANGE_FAILED' as const, message: 'Redirect URL not configured.' };
            tm.setSignedOutWithError(exchangeError);
            return;
          }

          const result = await exchangeCode({
            code,
            codeVerifier: storedVerifier,
            redirectUri: redirectUrl,
            clientId,
            baseUrl,
          });

          if (result.ok) {
            await tm.setTokens(result.data);
            tm['eventLog'].push({ type: 'signed_in', severity: 'info' });

            if (onRedirectCallback) {
              onRedirectCallback({ returnTo });
            } else if (returnTo && typeof window !== 'undefined') {
              window.history.replaceState(window.history.state, '', returnTo);
            }
          } else {
            tm.setSignedOutWithError(result.error);
            tm['eventLog'].push({ type: 'sign_in_failed', severity: 'warning', error: result.error });
          }
        })();

        return;
      }
    }

    void tm.restore();

    if (getNextEnv()['NODE_ENV'] !== 'production' && !preflightStarted.current) {
      preflightStarted.current = true;
      const runPreflight = () => {
        void (async () => {
          const issues: string[] = [];
          const ok: string[] = [];

          try {
            const res = await sdkFetch(`${baseUrl}/health`, {
              method: 'HEAD',
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              ok.push('API reachable');
            } else {
              issues.push(`API returned ${res.status}`);
            }

            const serverDate = res.headers.get('Date');
            if (serverDate) {
              const serverTime = new Date(serverDate).getTime();
              const skewMs = Math.abs(Date.now() - serverTime);
              if (skewMs > 30_000) {
                issues.push(`Clock skew detected (${Math.floor(skewMs / 1000)}s) — token expiry may be unreliable`);
              }
            }
          } catch {
            issues.push('API unreachable — check baseUrl and CORS');
          }

          if (typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') {
            issues.push('Web Crypto API unavailable — PKCE requires HTTPS or localhost');
          } else {
            ok.push('Web Crypto available');
          }

          if (redirectUrl && typeof window !== 'undefined') {
            try {
              const redir = new URL(redirectUrl);
              if (redir.origin !== window.location.origin) {
                issues.push(`redirectUrl origin (${redir.origin}) ≠ current origin (${window.location.origin})`);
              }
            } catch {
              issues.push('redirectUrl is not a valid URL');
            }
          }

          const lines = [
            '[Rakomi Preflight]',
            ...ok.map(m => `  ✓ ${m}`),
            ...issues.map(m => `  ✗ ${m}`),
          ];
          if (issues.length > 0) {
            console.warn(lines.join('\n'));
          } else {
            console.debug(lines.join('\n'));
          }

          tm['eventLog'].push({
            type: 'preflight_complete',
            severity: issues.length > 0 ? 'warning' : 'info',
            metadata: { issues, ok },
          });
        })();
      };

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(runPreflight, { timeout: 1000 });
      } else {
        setTimeout(runPreflight, 1000);
      }
    }

    return () => {
      tm.destroy();
      tokenManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (tokenManagerRef.current === null) return;

  }, [clientId, baseUrl]);

  const signInImpl = React.useCallback(
    async (options?: SignInOptions): Promise<SignInResult> => {
      const mode = options?.mode ?? 'direct';
      const tm = tokenManagerRef.current;
      if (!tm) return { status: 'error', error: { code: 'INVALID_CONFIG' as const, message: 'RakomiProvider not initialized' } };

      tm['eventLog'].push({ type: 'sign_in_attempted', severity: 'info' });

      if (mode === 'anonymous') {
        const anonResult = await anonymousSignIn({
          baseUrl,
          apiKey: clientId,
          publicMetadata: options?.publicMetadata,
        });
        if (!anonResult.ok) {
          tm['eventLog'].push({ type: 'sign_in_failed', severity: 'warning', error: anonResult.error });
          tm.setSignedOutWithError(anonResult.error);
          return { status: 'error', error: anonResult.error };
        }
        await tm.setTokens(anonResult.data);
        tm['eventLog'].push({ type: 'signed_in', severity: 'info' });
        return { status: 'complete' };
      }

      if (mode === 'direct') {
        if (!options?.email || !options?.password) {
          const error = { code: 'SIGN_IN_FAILED' as const, message: 'email and password are required for direct mode' };
          tm['eventLog'].push({ type: 'sign_in_failed', severity: 'warning', error });
          tm.setSignedOutWithError(error);
          return { status: 'error', error };
        }

        const result = await directSignIn({
          baseUrl,
          email: options.email,
          password: options.password,
          apiKey: clientId,
        });

        if (!result.ok) {
          tm['eventLog'].push({ type: 'sign_in_failed', severity: 'warning', error: result.error });
          tm.setSignedOutWithError(result.error);
          return { status: 'error', error: result.error };
        }

        if ('nextStep' in result && result.nextStep === 'mfa_challenge') {
          return { status: 'mfa_required', challengeToken: result.challengeToken, expiresIn: result.expiresIn };
        }

        if ('nextStep' in result && result.nextStep === 'mfa_setup_required') {
          return { status: 'mfa_setup_required', graceDeadlineAt: result.graceDeadlineAt };
        }

        await tm.setTokens(result.data);
        tm['eventLog'].push({ type: 'signed_in', severity: 'info' });
        return { status: 'complete' };
      }

      if (typeof window === 'undefined') {
        return { status: 'complete' };
      }

      const returnTo = options?.returnTo;
      if (returnTo !== undefined && !returnTo.startsWith('/')) {
        throw new Error('[Rakomi] returnTo must be a relative path (starts with "/"). Absolute URLs are not permitted.');
      }

      const { codeVerifier, codeChallenge } = await generatePKCE();
      const state = generateState();
      const resolvedRedirect = redirectUrl ?? `${window.location.origin}/oauth/callback`;

      try {
        const redir = new URL(resolvedRedirect);
        if (redir.origin !== window.location.origin) {
          throw new Error(
            `[Rakomi] redirectUrl origin (${redir.origin}) must match current origin (${window.location.origin}). ` +
            'Cross-origin redirect URIs are not permitted for public clients.',
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Rakomi')) throw e;
      }

      setSessionItem(`rakomi:${clientId}:pkce_verifier`, codeVerifier);
      setSessionItem(oauthStateKey(clientId), state);
      if (returnTo) {
        setSessionItem(`rakomi:${clientId}:return_to`, returnTo);
      }

      const authorizeUrl = buildAuthorizeUrl({
        baseUrl,
        clientId,
        redirectUri: resolvedRedirect,
        state,
        codeChallenge,
      });

      window.location.href = authorizeUrl;
      return { status: 'redirect' };
    },
    [clientId, baseUrl, redirectUrl],
  );

  const signOutImpl = React.useCallback(async (): Promise<void> => {
    const tm = tokenManagerRef.current;
    if (!tm) return;

    await tm.clear();

    tm['eventLog'].push({ type: 'signed_out', severity: 'info' });

  }, []);

  tokenManager.signIn = signInImpl;
  tokenManager.signOut = signOutImpl;

  const resolvedRedirect = redirectUrl ?? (typeof window !== 'undefined' ? `${window.location.origin}/oauth/callback` : '');
  const internalsRef = useRef<RakomiInternals | null>(null);
  const brandingJson = props.branding ? JSON.stringify(props.branding) : undefined;
  const prevBrandingJson = internalsRef.current?.brandingOverride ? JSON.stringify(internalsRef.current.brandingOverride) : undefined;
  if (internalsRef.current === null || internalsRef.current.baseUrl !== baseUrl || internalsRef.current.clientId !== clientId || internalsRef.current.redirectUrl !== resolvedRedirect || brandingJson !== prevBrandingJson) {
    internalsRef.current = {
      baseUrl,
      clientId,
      redirectUrl: resolvedRedirect || '',
      brandingOverride: props.branding,
      completeSignIn: async (tokens: OAuthTokenResponse) => {
        const tm = tokenManagerRef.current;
        if (!tm) return;
        await tm.setTokens(tokens);
        tm['eventLog'].push({ type: 'signed_in', severity: 'info' });
      },
      emitEvent: (event) => {
        const tm = tokenManagerRef.current;
        if (!tm) return;
        tm['eventLog'].push(event);
      },
      setPersistence: async (newPersistence: 'session' | 'local') => {
        const tm = tokenManagerRef.current;
        if (!tm) return;
        const newStorage = resolveStorage(newPersistence);
        await tm.setPersistence(newStorage);
      },
    };
  }

  return (
    <RakomiContext.Provider value={authState}>
      <AuthConfigManagerContext.Provider value={configManager}>
        <RakomiLocaleContext.Provider value={props.locale}>
          <RakomiTranslationsContext.Provider value={props.translations}>
            <RakomiColorSchemeContext.Provider value={props.colorScheme}>
              <AppearanceContext.Provider value={props.appearance}>
                <RakomiInternalsContext.Provider value={internalsRef.current}>
                  {children}
                </RakomiInternalsContext.Provider>
              </AppearanceContext.Provider>
            </RakomiColorSchemeContext.Provider>
          </RakomiTranslationsContext.Provider>
        </RakomiLocaleContext.Provider>
      </AuthConfigManagerContext.Provider>
    </RakomiContext.Provider>
  );
}

/**
 * Internal hook — returns raw AuthState.
 * Throws with a descriptive error when used outside a RakomiProvider.
 */
export function useRakomiContext(): AuthState {
  const ctx = useContext(RakomiContext);
  if (ctx === undefined) {
    throw new Error(
      '[Rakomi] useAuth() / useUser() / useSession() must be called inside <RakomiProvider>. ' +
      'Wrap your app (or the component tree) with <RakomiProvider clientId="...">.',
    );
  }
  return ctx;
}

function getSessionItem(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSessionItem(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
  }
}

function removeSessionItem(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
  }
}

function cleanOAuthParams(url: URL): void {
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState(window.history.state, '', url.toString());
}
