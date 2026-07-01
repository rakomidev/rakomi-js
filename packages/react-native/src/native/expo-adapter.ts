/**
 * Default Expo adapter — wires the `NativeAuthAdapter` interface to Expo modules.
 *
 * Modules are imported dynamically inside the factory so:
 * - Bare-RN consumers who pass a custom adapter don't pay the Expo bundle cost.
 * - Consumers who never use biometric don't pay the `expo-local-authentication`
 *   cost (lazy-load).
 *
 * Hardening:
 * - The returned adapter is `Object.freeze`-able by callers; this module returns
 *   a plain object — `<RakomiProvider>` freezes it on mount.
 * - No `console.log` of token values anywhere in this file.
 *
 * Native-passkey integration (`react-native-passkey`, ASAuthorization) is
 * out-of-scope here.
 */

import type { CryptoProvider, KeyValueStore } from '@rakomi/sdk-core';

import type {
  AppLifecycle,
  BiometricGate,
  ConnectivityProvider,
  DeepLinkProvider,
  NativeAuthAdapter,
  SystemBrowser,
  TokenCache,
} from './types.js';

/**
 * Build the default Expo-backed `NativeAuthAdapter`.
 *
 * Each capability is lazily resolved on first use to keep the cold-import bundle
 * small (perf budget). The resolution is memoised internally.
 */
export function createDefaultExpoAdapter(options: CreateDefaultExpoAdapterOptions = {}): NativeAuthAdapter {
  const crypto = createExpoCrypto();
  const storage = createExpoSecureStore({ tokenCache: options.tokenCache });
  const browser = createExpoBrowser();
  const deepLink = createExpoDeepLink();
  const biometric = createExpoBiometricGate();
  const appLifecycle = createRnAppLifecycle();
  const connectivity = createNetInfoConnectivity();

  return {
    crypto,
    storage,
    browser,
    deepLink,
    biometric,
    appLifecycle,
    connectivity,
  };
}

export interface CreateDefaultExpoAdapterOptions {
  /**
 * Override storage with the consumer's own token cache (sugar).
 * When provided, `crypto`/`browser`/`deepLink`/`biometric`/`appLifecycle`/`connectivity`
 * still come from Expo defaults; only storage is replaced.
 */
  tokenCache?: TokenCache;
}

function createExpoCrypto(): CryptoProvider {
  let mod: ExpoCryptoModule | null = null;
  async function load(): Promise<ExpoCryptoModule> {
    if (!mod) {
      mod = (await import('expo-crypto').catch(() => null)) as any;
      if (!mod) {
        throw new Error(
          '@rakomi/react-native: expo-crypto is required for the default adapter. ' +
            'Install it (Expo-managed) or pass a custom nativeAdapter (bare RN).',
        );
      }
    }
    return mod;
  }
  return {
    getRandomBytes: async (n) => {
      const m = await load();
      const result = await m.getRandomBytesAsync(n);
      return new Uint8Array(result);
    },
    digestSha256: async (input) => {
      const m = await load();
      let str = '';
      for (let i = 0; i < input.length; i++) str += String.fromCharCode(input[i]!);
      const hex = await m.digestStringAsync(
        m.CryptoDigestAlgorithm.SHA256,
        str,
        { encoding: m.CryptoEncoding.HEX },
      );
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    },
  };
}

function createExpoSecureStore(opts: { tokenCache?: TokenCache }): KeyValueStore {
  if (opts.tokenCache) {
    const tc = opts.tokenCache;
    return {
      getItem: (key) => tc.getToken(key),
      setItem: async (key, value) => {
        await tc.saveToken(key, value);
      },
      removeItem: (key) => tc.clearToken(key),
    };
  }

  let mod: ExpoSecureStoreModule | null = null;
  async function load(): Promise<ExpoSecureStoreModule> {
    if (!mod) {
      mod = (await import('expo-secure-store').catch(() => null)) as any;
      if (!mod) {
        throw new Error(
          '@rakomi/react-native: expo-secure-store is required for the default adapter. ' +
            'Install it (Expo-managed) or pass `tokenCache` / a custom nativeAdapter.',
        );
      }
    }
    return mod;
  }

  return {
    getItem: async (key, options) => {
      const m = await load();
      return m.getItemAsync(key, {
        requireAuthentication: options?.requireAuthentication,
        authenticationPrompt: options?.authenticationPrompt,
      });
    },
    setItem: async (key, value, options) => {
      const m = await load();
      const accessibility = mapKeychainAccessible(
        m,
        options?.keychainAccessible ?? 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
      );
      await m.setItemAsync(key, value, {
        keychainAccessible: accessibility,
        requireAuthentication: options?.requireAuthentication,
        authenticationPrompt: options?.authenticationPrompt,
      });
    },
    removeItem: async (key) => {
      const m = await load();
      await m.deleteItemAsync(key);
    },
  };
}

function mapKeychainAccessible(
  m: ExpoSecureStoreModule,
  level:
    | 'WHEN_UNLOCKED'
    | 'AFTER_FIRST_UNLOCK'
    | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
    | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
    | 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY',
): unknown {
  switch (level) {
    case 'WHEN_UNLOCKED':
      return m.WHEN_UNLOCKED;
    case 'AFTER_FIRST_UNLOCK':
      return m.AFTER_FIRST_UNLOCK;
    case 'WHEN_UNLOCKED_THIS_DEVICE_ONLY':
      return m.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
    case 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY':
      return m.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
    case 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY':
      return m.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY;
  }
}

function createExpoBrowser(): SystemBrowser {
  let mod: ExpoWebBrowserModule | null = null;
  async function load(): Promise<ExpoWebBrowserModule> {
    if (!mod) {
      mod = (await import('expo-web-browser').catch(() => null)) as any;
      if (!mod) {
        throw new Error('@rakomi/react-native: expo-web-browser is required for OAuth flows.');
      }
    }
    return mod;
  }

  return {
    openAuthSession: async (authUrl, redirectUri, options) => {
      const m = await load();
      const result = await m.openAuthSessionAsync(authUrl, redirectUri, {
        preferEphemeralSession: options?.preferEphemeralSession ?? true,
      });
      if (result.type === 'success' && result.url) {
        return { type: 'success', url: result.url };
      }
      if (result.type === 'cancel') return { type: 'cancel' };
      if (result.type === 'dismiss') return { type: 'dismiss' };
      if (result.type === 'locked') return { type: 'locked' };
      return { type: 'cancel' };
    },
  };
}

function createExpoDeepLink(): DeepLinkProvider {
  let mod: ExpoLinkingModule | null = null;
  async function load(): Promise<ExpoLinkingModule> {
    if (!mod) {
      mod = (await import('expo-linking').catch(() => null)) as any;
      if (!mod) {
        throw new Error('@rakomi/react-native: expo-linking is required for OAuth deep-link callback.');
      }
    }
    return mod;
  }
  return {
    getInitialUrl: async () => {
      const m = await load();
      return m.getInitialURL();
    },
    addListener: (listener) => {
      let sub: { remove(): void } | null = null;
      void load().then((m) => {
        sub = m.addEventListener('url', (event) => listener(event.url));
      });
      return {
        remove: () => {
          sub?.remove();
        },
      };
    },
  };
}

function createExpoBiometricGate(): BiometricGate {
  let mod: ExpoLocalAuthModule | null = null;
  async function load(): Promise<ExpoLocalAuthModule | null> {
    if (mod !== null) return mod;
    try {
      mod = (await import('expo-local-authentication')) as any;
    } catch {
      mod = null;
    }
    return mod;
  }

  return {
    isAvailable: async () => {
      const m = await load();
      if (!m) return false;
      const has = await m.hasHardwareAsync();
      if (!has) return false;
      const enrolled = await m.isEnrolledAsync();
      return enrolled;
    },
    authenticate: async ({ promptMessage, strict = false }) => {
      const m = await load();
      if (!m) return { success: false, reason: 'unavailable' };
      const result = await m.authenticateAsync({
        promptMessage,
        disableDeviceFallback: strict,
        fallbackLabel: 'Use passcode',
      });
      if (result.success) return { success: true };
      switch (result.error) {
        case 'user_cancel':
        case 'system_cancel':
        case 'app_cancel':
          return { success: false, reason: 'cancelled' };
        case 'lockout':
        case 'lockout_permanent':
          return { success: false, reason: 'lockout' };
        case 'not_enrolled':
          return { success: false, reason: 'not_enrolled' };
        case 'not_available':
        case 'no_space':
          return { success: false, reason: 'unavailable' };
        default:
          return { success: false, reason: 'unknown' };
      }
    },
  };
}

function createRnAppLifecycle(): AppLifecycle {
  type RnModule = {
    AppState: {
      currentState: string;
      addEventListener(ev: string, cb: (s: string) => void): { remove(): void };
    };
  };
  let rn: RnModule | null = null;
  let pending: Promise<RnModule> | null = null;
  async function ensure(): Promise<RnModule> {
    if (rn) return rn;
    if (!pending) {
      pending = (import('react-native') as Promise<any>).then((m) => {
        rn = (m.default ?? m) as RnModule;
        return rn;
      });
    }
    return pending;
  }
  void ensure().catch(() => undefined);

  return {
    addStateChangeListener: (listener) => {
      let sub: { remove(): void } | null = null;
      void ensure().then((r) => {
        sub = r.AppState.addEventListener('change', (next: string) => {
          listener(coerceAppState(next));
        });
      });
      return { remove: () => sub?.remove() };
    },
    getCurrent: () => (rn ? coerceAppState(rn.AppState.currentState) : 'unknown'),
  };
}

function coerceAppState(value: string): 'active' | 'background' | 'inactive' | 'unknown' {
  if (value === 'active' || value === 'background' || value === 'inactive') return value;
  return 'unknown';
}

function createNetInfoConnectivity(): ConnectivityProvider {
  let mod: NetInfoModule | null = null;
  async function load(): Promise<NetInfoModule | null> {
    if (mod !== null) return mod;
    try {
      mod = ((await import('@react-native-community/netinfo')) as any).default ?? null;
    } catch {
      mod = null;
    }
    return mod;
  }
  return {
    isConnected: async () => {
      const m = await load();
      if (!m) return true;
      const state = await m.fetch();
      return state.isConnected ?? true;
    },
    addListener: (listener) => {
      let unsubscribe: (() => void) | null = null;
      void load().then((m) => {
        if (!m) return;
        unsubscribe = m.addEventListener((state) => listener(state.isConnected ?? true));
      });
      return { remove: () => unsubscribe?.() };
    },
  };
}

interface ExpoCryptoModule {
  getRandomBytesAsync(n: number): Promise<Uint8Array>;
  digestStringAsync(algorithm: unknown, str: string, options: { encoding: unknown }): Promise<string>;
  CryptoDigestAlgorithm: { SHA256: unknown };
  CryptoEncoding: { HEX: unknown };
}

interface ExpoSecureStoreModule {
  getItemAsync(key: string, options?: { requireAuthentication?: boolean; authenticationPrompt?: string }): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: { keychainAccessible?: unknown; requireAuthentication?: boolean; authenticationPrompt?: string },
  ): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  WHEN_UNLOCKED: unknown;
  AFTER_FIRST_UNLOCK: unknown;
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: unknown;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: unknown;
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: unknown;
}

interface ExpoWebBrowserModule {
  openAuthSessionAsync(
    url: string,
    redirectUrl: string,
    options?: { preferEphemeralSession?: boolean },
  ): Promise<{ type: 'success' | 'cancel' | 'dismiss' | 'locked' | 'opened'; url?: string }>;
}

interface ExpoLinkingModule {
  getInitialURL(): Promise<string | null>;
  addEventListener(event: 'url', cb: (event: { url: string }) => void): { remove(): void };
}

interface ExpoLocalAuthModule {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(options: {
    promptMessage: string;
    disableDeviceFallback?: boolean;
    fallbackLabel?: string;
  }): Promise<{ success: true } | { success: false; error: string }>;
}

interface NetInfoModule {
  fetch(): Promise<{ isConnected: boolean | null }>;
  addEventListener(listener: (state: { isConnected: boolean | null }) => void): () => void;
}
