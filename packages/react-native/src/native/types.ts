/**
 * `NativeAuthAdapter` — single typed surface that swaps every
 * browser-coupled primitive in `@rakomi/react` for an RN/Expo equivalent.
 *
 * It is the source of truth for which native module backs each capability.
 * The default impl in `./expo-adapter.ts` wires Expo modules; bare-RN consumers
 * wire their own via `<RakomiProvider nativeAdapter={...}>`.
 *
 * Forward-compat slots (typed, optional, no default impl):
 * - `verifiers` for EUDI Wallet attestation (eIDAS 2 / Reg. 2024/1183, end-2026 mandate).
 * - `dpopProver` for RFC 9449 DPoP.
 * - `pushAuthorizationRequest` for RFC 9126 PAR.
 *
 * Hardening rules:
 * - The provider MUST `Object.freeze` the adapter on first use.
 * - Adapter methods MUST NOT log token values.
 * - Adapter is the ONLY layer touching expo-* modules — keeps SDK core platform-neutral.
 */

import type { CryptoProvider, KeyValueStore } from '@rakomi/sdk-core';

export interface BrowserAuthSessionOptions {
  /**
 * iOS-only. Defaults to `true` for stricter privacy
 * (no shared cookies). Consumer can opt out via `<RakomiProvider browserPreferEphemeralSession={false}>`.
 */
  preferEphemeralSession?: boolean;
}

export type BrowserAuthSessionResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' }
  | { type: 'locked' };

export interface SystemBrowser {
  /**
 * Open `authUrl` in the OS system browser (ASWebAuthenticationSession on iOS,
 * Custom Tabs on Android). The OS returns a `redirectUri`-prefixed URL when
 * the OAuth provider redirects.
 *
 * Implementations MUST NOT use any kind of WebView (RFC 8252).
 */
  openAuthSession(
    authUrl: string,
    redirectUri: string,
    options?: BrowserAuthSessionOptions,
  ): Promise<BrowserAuthSessionResult>;
}

export interface DeepLinkSubscription {
  /** Stop receiving callbacks. Idempotent. */
  remove(): void;
}

export interface DeepLinkProvider {
  /**
   * Return the URL the app was launched with, if any. Cold start case.
   */
  getInitialUrl(): Promise<string | null>;

  /**
 * Subscribe to incoming deep links. Listener is called with each URL.
 * Implementations MUST debounce duplicate URLs within ~60s (single-use guard)
 * — but typically the SDK layer enforces this, not the adapter.
 */
  addListener(listener: (url: string) => void): DeepLinkSubscription;
}

export type BiometricResult =
  | { success: true }
  | { success: false; reason: 'cancelled' | 'lockout' | 'not_enrolled' | 'unavailable' | 'unknown' };

export interface BiometricGate {
  /**
   * Return `true` if the device has hardware AND the user has enrolled biometrics
   * (or a passcode, when `disableDeviceFallback === false`).
   */
  isAvailable(): Promise<boolean>;

  /**
 * Prompt the user for biometric authentication.
 *
 * `strict: true` disables passcode fallback (`disableDeviceFallback: true`).
 * Default is `false` (allow device passcode).
 */
  authenticate(options: { promptMessage: string; strict?: boolean }): Promise<BiometricResult>;
}

export type AppStateValue = 'active' | 'background' | 'inactive' | 'unknown';

export interface AppStateSubscription {
  remove(): void;
}

export interface AppLifecycle {
  /**
 * Subscribe to AppState transitions.
 *
 * Android Q+ fires `AppState` twice on keyboard
 * dismiss — the SDK layer (not the adapter) MUST debounce ~300ms.
 */
  addStateChangeListener(listener: (next: AppStateValue) => void): AppStateSubscription;

  /** Read current state synchronously. */
  getCurrent(): AppStateValue;
}

export interface NetInfoSubscription {
  remove(): void;
}

export interface ConnectivityProvider {
  /** Resolve once with the current connectivity state. */
  isConnected(): Promise<boolean>;

  /** Subscribe to connectivity transitions. */
  addListener(listener: (isConnected: boolean) => void): NetInfoSubscription;
}

/** Reserved for EUDI Wallet attestation verifiers (eIDAS 2). */
export interface AttestationVerifier {
  readonly id: string;
  verify(presentation: unknown): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * RFC 9449 DPoP proof generator — the canonical cross-port prover contract.
 * `@rakomi/node`'s `createDpopProver` is the conformance oracle the proof
 * *shape* matches byte-for-byte in structure.
 *
 * SECURITY — the production RN prover MUST bridge signing to the native
 * keystore (iOS Keychain / Secure Enclave, Android Keystore/StrongBox) and MUST
 * NEVER sign in the JS bundle: only `{jti, iat, nonce?}` + the signature cross
 * the bridge; the private key never leaves the secure element. The prover OWNS
 * every security-relevant proof field — `jti` (CSPRNG UUID, fresh per call),
 * `iat` (seconds NumericDate), `typ: "dpop+jwt"`, the public-only `jwk`, and the
 * pinned `alg` (`ES256` — the cross-port baseline, Secure-Enclave-eligible;
 * NEVER derived from a key or any input). The caller supplies ONLY the canonical
 * request binding (`htm`/`htu`) and the optional server `nonce`; it can never
 * influence the algorithm or inject claims, and the proof carries NO PII
 * (exactly `{htm, htu, jti, iat}` body + optional `nonce`).
 */
export interface DpopProofInput {
  /** HTTP method of the bound request — `"POST"` for the refresh call. */
  htm: string;
  /**
   * The ALREADY-canonical `htu` (RFC 9449 §4.3 — scheme+host+path, query/fragment
   * stripped, default port stripped). The SDK decision layer canonicalizes; the
   * prover signs it verbatim and MUST NOT re-derive or mutate it.
   */
  htu: string;
  /** Optional RFC 9449 §8 server nonce, echoed into the proof on a retry. */
  nonce?: string;
}

export interface DpopProver {
  /**
   * Build a compact-serialized DPoP-proof JWT for the bound request. Resolves to
   * the `DPoP` header value. The prover signs with the session's single native
   * keypair (one keypair per session — never re-generated per call). MUST reject
   * (never return an empty/falsy string) if the native signer is unavailable so
   * the SDK surfaces `dpop_prover_unavailable` instead of a silent Bearer call.
   */
  createProof(input: DpopProofInput): Promise<string>;
  /**
   * RFC 7638 SHA-256 thumbprint of the prover's public JWK — lets the SDK's
   * bound-state cross-check pair `token_type === "DPoP"` with a `jkt` sanity
   * check (`jkt`-continuity). Resolves the SAME value for the life
   * of the session's keypair.
   */
  jktHint(): Promise<string>;
}

/** Reserved for RFC 9126 PAR (Pushed Authorization Requests). */
export interface ParClient {
  push(authorizationRequest: Record<string, string>): Promise<{ requestUri: string; expiresIn: number }>;
}

/**
 * Background-fetch contract — best-effort token refresh while the app is suspended
 * (Expo Task Manager / expo-background-fetch on Expo, BGTaskScheduler on iOS / WorkManager on Android
 * for bare-RN consumers).
 *
 * The OS controls scheduling; the SDK only registers the work and provides the handler.
 * best-effort, NOT guaranteed delivery.
 */
export interface BackgroundTask {
  /**
   * Register a periodic refresh task. The handler is called by the OS at OS-decided intervals
   * (≥15 min on Android; OS-throttled on iOS). Returns an unregister function.
   */
  register(handler: () => Promise<void>, options?: { minimumIntervalSeconds?: number }): Promise<() => Promise<void>>;
  /** Resolve `true` if the OS reports background-fetch as available + not user-disabled. */
  isAvailable(): Promise<boolean>;
}

export interface NativeAuthAdapter {
  readonly crypto: CryptoProvider;
  readonly storage: KeyValueStore;
  readonly browser: SystemBrowser;
  readonly deepLink: DeepLinkProvider;
  readonly biometric: BiometricGate;
  readonly appLifecycle: AppLifecycle;
  readonly connectivity: ConnectivityProvider;

  readonly verifiers?: readonly AttestationVerifier[];
  readonly dpopProver?: DpopProver;
  readonly par?: ParClient;
  /** Optional best-effort background refresh hook. */
  readonly backgroundTask?: BackgroundTask;
}

/**
 * `tokenCache` injection sugar (shorthand).
 *
 * If a consumer just wants to override storage without re-implementing the full adapter,
 * they pass `tokenCache` and the SDK constructs an adapter that delegates only
 * `storage` to `tokenCache` while inheriting the rest from the default Expo adapter.
 */
export interface TokenCache {
  getToken(key: string): Promise<string | null>;
  saveToken(key: string, value: string): Promise<void>;
  clearToken(key: string): Promise<void>;
}
