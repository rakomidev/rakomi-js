/**
 * Reference implementation: bare React Native `NativeAuthAdapter`.
 *
 * For consumers NOT on Expo. Wires the same contract the default Expo adapter
 * implements (`createDefaultExpoAdapter`) but using bare-RN-friendly community
 * packages:
 *
 * - `react-native-keychain` for secure storage
 * - `react-native-inappbrowser-reborn` for system browser (Custom Tabs / SFSafariViewController)
 * - `react-native-quick-crypto` for `getRandomBytes` + `digestSha256`
 * - `react-native/Linking` for deep-link callback ingest
 * - `react-native-biometrics` for biometric gate
 * - `react-native/AppState` for app-lifecycle transitions
 * - `@react-native-community/netinfo` for connectivity
 *
 * **Not a default export** bare-RN consumers MUST call `createBareRnAdapter`
 * explicitly and pass the result via `<RakomiProvider nativeAdapter={...}>`. We
 * keep this in `src/native/` as documentation/reference; the actual implementation
 * stubs are intentional — `NotImplementedError` thrown lines indicate where the
 * bare-RN package import goes. Replace the throws with the real package binding.
 *
 * Why stubbed: bare-RN packages have install-time native code that can't be
 * imported at SDK build time. Consumer's bundler links them at app build.
 */

import type { CryptoProvider, KeyValueStore } from '@rakomi/sdk-core';

import type {
  AppLifecycle,
  BiometricGate,
  ConnectivityProvider,
  DeepLinkProvider,
  NativeAuthAdapter,
  SystemBrowser,
} from './types.js';

export interface CreateBareRnAdapterOptions {
  /** Required injection — `react-native-quick-crypto` named exports. */
  quickCrypto: {
    randomBytes(length: number): Uint8Array;
    createHash(alg: 'sha256'): { update(b: Uint8Array): { digest(): Uint8Array } };
  };
  /** Required injection — `react-native-keychain` namespace. */
  keychain: {
    setGenericPassword(username: string, password: string, options: { service: string; accessible?: string }): Promise<unknown>;
    getGenericPassword(options: { service: string; authenticationPrompt?: { title: string } }): Promise<{ username: string; password: string } | false>;
    resetGenericPassword(options: { service: string }): Promise<boolean>;
  };
  /** Required injection — `react-native-inappbrowser-reborn` namespace. */
  inAppBrowser: {
    isAvailable(): Promise<boolean>;
    openAuth(url: string, redirectUri: string, options?: { ephemeralWebSession?: boolean }): Promise<{ type: 'success' | 'cancel' | 'dismiss'; url?: string }>;
  };
  /** Required injection — `react-native-biometrics` instance. */
  biometrics: {
    isSensorAvailable(): Promise<{ available: boolean; biometryType?: string }>;
    simplePrompt(options: { promptMessage: string; cancelButtonText?: string }): Promise<{ success: boolean; error?: string }>;
  };
  /** Required injection — `react-native/Linking` namespace. */
  linking: {
    getInitialURL(): Promise<string | null>;
    addEventListener(event: 'url', handler: (e: { url: string }) => void): { remove(): void };
  };
  /** Required injection — `react-native/AppState` namespace. */
  appState: {
    currentState: 'active' | 'background' | 'inactive' | 'unknown';
    addEventListener(event: 'change', handler: (state: 'active' | 'background' | 'inactive' | 'unknown') => void): { remove(): void };
  };
  /** Required injection — `@react-native-community/netinfo` namespace. */
  netInfo: {
    fetch(): Promise<{ isConnected: boolean | null }>;
    addEventListener(handler: (state: { isConnected: boolean | null }) => void): () => void;
  };
  /** Tenant-scoped Keychain service prefix. Default `'rakomi'`. */
  keychainServicePrefix?: string;
}

export function createBareRnAdapter(options: CreateBareRnAdapterOptions): NativeAuthAdapter {
  const servicePrefix = options.keychainServicePrefix ?? 'rakomi';

  const crypto: CryptoProvider = {
    getRandomBytes: async (length) => new Uint8Array(options.quickCrypto.randomBytes(length)),
    digestSha256: async (input) => new Uint8Array(options.quickCrypto.createHash('sha256').update(input).digest()),
  };

  const storage: KeyValueStore = {
    getItem: async (key, opts) => {
      const result = await options.keychain.getGenericPassword({
        service: `${servicePrefix}.${key}`,
        ...(opts?.requireAuthentication
          ? { authenticationPrompt: { title: opts.authenticationPrompt ?? 'Authenticate' } }
          : {}),
      });
      return result ? result.password : null;
    },
    setItem: async (key, value, opts) => {
      await options.keychain.setGenericPassword('rakomi', value, {
        service: `${servicePrefix}.${key}`,
        accessible: opts?.keychainAccessible ?? 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
      });
    },
    removeItem: async (key) => {
      await options.keychain.resetGenericPassword({ service: `${servicePrefix}.${key}` });
    },
  };

  const browser: SystemBrowser = {
    openAuthSession: async (authUrl, redirectUri, opts) => {
      const available = await options.inAppBrowser.isAvailable();
      if (!available) return { type: 'locked' };
      const result = await options.inAppBrowser.openAuth(authUrl, redirectUri, {
        ephemeralWebSession: opts?.preferEphemeralSession ?? true,
      });
      if (result.type === 'success' && result.url) return { type: 'success', url: result.url };
      if (result.type === 'cancel') return { type: 'cancel' };
      return { type: 'dismiss' };
    },
  };

  const deepLink: DeepLinkProvider = {
    getInitialUrl: () => options.linking.getInitialURL(),
    addListener: (listener) => options.linking.addEventListener('url', (e) => listener(e.url)),
  };

  const biometric: BiometricGate = {
    isAvailable: async () => {
      const sensor = await options.biometrics.isSensorAvailable();
      return sensor.available;
    },
    authenticate: async ({ promptMessage }) => {
      const result = await options.biometrics.simplePrompt({ promptMessage });
      if (result.success) return { success: true };
      return { success: false, reason: 'cancelled' };
    },
  };

  const appLifecycle: AppLifecycle = {
    addStateChangeListener: (listener) => options.appState.addEventListener('change', listener),
    getCurrent: () => options.appState.currentState,
  };

  const connectivity: ConnectivityProvider = {
    isConnected: async () => {
      const state = await options.netInfo.fetch();
      return state.isConnected === true;
    },
    addListener: (listener) => {
      const unsub = options.netInfo.addEventListener((state) => listener(state.isConnected === true));
      return { remove: unsub };
    },
  };

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
