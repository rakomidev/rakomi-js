/**
 * Platform-adapter contracts.
 *
 * `@rakomi/sdk-core` is platform-neutral — no `crypto.subtle`, no `localStorage`,
 * no global `fetch` assumptions baked into algorithms. Platform-coupled operations
 * are injected via these typed interfaces.
 *
 * Web SDK (`@rakomi/react`) wires these to Web Crypto / `localStorage` / WHATWG fetch.
 * Mobile SDK (`@rakomi/react-native`) wires these to `expo-crypto` / `expo-secure-store`.
 *
 * Design rules:
 *  - All methods are async (RN `expo-secure-store` is async; web SDK wraps sync APIs in Promise.resolve).
 *  - No method may return raw token bytes; binary I/O is `Uint8Array` end-to-end.
 *  - Adapters MUST be safe to `Object.freeze` after construction.
 */

/**
 * Cryptographic primitives the SDK needs.
 *
 * Implementations MUST source randomness from a CSPRNG:
 *  - Web: `crypto.getRandomValues`.
 *  - RN/Expo: `expo-crypto.getRandomBytesAsync`.
 *  - Bare RN: `react-native-quick-crypto`.
 *
 * NEVER `Math.random()`.
 */
export interface CryptoProvider {
  /**
   * Return `length` cryptographically-random bytes.
   * @param length number of bytes (callers in this SDK use 32 for PKCE verifier + state).
   */
  getRandomBytes(length: number): Promise<Uint8Array>;

  /**
   * SHA-256 digest of the input bytes. Used for PKCE S256 challenge.
   * Implementation MUST use a hardware-backed or WebCrypto-backed hash, never a JS polyfill.
   */
  digestSha256(input: Uint8Array): Promise<Uint8Array>;
}

/**
 * Async key-value persistence with optional biometric/auth-required gate.
 *
 * Web: localStorage / sessionStorage / IndexedDB wrapper.
 * RN: `expo-secure-store` (Keychain / Keystore — encrypted-at-rest by OS).
 *
 * Implementations MUST treat values as opaque strings; no parsing.
 * Implementations MAY enforce per-key biometric prompts via `options.requireAuthentication`
 * (RN only — web ignores).
 */
export interface KeyValueStore {
  getItem(key: string, options?: KeyValueGetOptions): Promise<string | null>;
  setItem(key: string, value: string, options?: KeyValueSetOptions): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface KeyValueGetOptions {
  /** RN: prompt biometric / device passcode before returning value. Web ignores. */
  requireAuthentication?: boolean;
  /** RN: localized prompt shown when `requireAuthentication: true`. */
  authenticationPrompt?: string;
}

export interface KeyValueSetOptions {
  /**
 * RN keychainAccessible policy.
 * Default for refresh tokens: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'.
 * Prevents iCloud Keychain sync of refresh tokens.
 */
  keychainAccessible?:
    | 'WHEN_UNLOCKED'
    | 'AFTER_FIRST_UNLOCK'
    | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
    | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
    | 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY';
  /** RN: require biometric to read the value back. */
  requireAuthentication?: boolean;
  /** RN: localized prompt for read-time biometric. */
  authenticationPrompt?: string;
}

/**
 * Minimal HTTP client interface.
 *
 * Both web and RN platforms have WHATWG-compatible `fetch`. The interface
 * isolates the SDK from `globalThis.fetch` assumptions and lets consumers
 * inject custom retry / telemetry / mTLS layers.
 *
 * Implementations MUST:
 *  - Set `redirect: 'error'`.
 *  - Honor `signal` for cancellation.
 *  - Return the raw `Response` — caller decides parsing.
 */
export interface HttpClient {
  fetch(url: string, init?: HttpClientInit): Promise<Response>;
}

export interface HttpClientInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  signal?: AbortSignal;
}
