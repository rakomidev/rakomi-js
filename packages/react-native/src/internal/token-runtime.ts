/**
 * `TokenRuntime` — the RN token manager.
 *
 * Pairs the platform-neutral FSM (`@rakomi/sdk-core/auth-machine`) with the RN-coupled
 * adapter (storage / http / crypto / connectivity / biometric). Lives in the SDK layer —
 * NOT in React render tree — so timers + in-flight Promises survive React re-renders.
 *
 * Security invariants (parity with web SDK + RN-specific):
 * - Access token: in-memory only (NEVER persisted).
 * - Refresh token: in `KeyValueStore` (Keychain / Keystore via expo-secure-store), keyed by
 * `deriveTenantStorageKey(tenantId, 'refresh_token')` and prefixed with `'v1:'` integrity tag.
 * - Biometric gate: when `biometric: true`, refresh-token READ requires `BiometricGate.authenticate`
 * AND the secure-store `requireAuthentication` flag — belt-and-suspenders.
 * - Auth errors (401/403/invalid_grant/revoked): clear immediately, ZERO retry.
 * - Network errors (5xx/offline): retry 3x with exponential backoff (2s / 8s / 30s).
 * - Single in-flight refresh Promise — concurrent callers dedupe.
 * - GDPR Art. 17: clear erases tokens AND in-memory state.
 * - No token values logged anywhere (eslint the project lint guards enforces).
 */

import { jwtVerify } from 'jose';

import {
  type AuthError,
  createJwksCache,
  decodeSession,
  decodeUser,
  deriveTenantStorageKey,
  type HttpClient,
  type JwksCache,
  type JwksDocument,
  type KeyValueStore,
  type MachineAction,
  type OAuthTokenResponse,
  refreshAccessToken,
  type SessionResource,
  type TokenResult,
  type UserResource,
} from '@rakomi/sdk-core';

import type { BiometricGate } from '../native/types.js';
import { type DpopRefreshError, refreshWithDpop } from './dpop-refresh.js';
import type { DpopSession } from './dpop-session.js';

/** Retry delays for network errors: 2s / 8s / 30s. */
const RETRY_DELAYS_MS = [2000, 8000, 30000] as const;

/**
 * Derive a sensible default JWKS URI from the OAuth token endpoint.
 * `https://api.example.com/oauth/token` → `https://api.example.com/.well-known/jwks.json`.
 * Falls back to appending `/.well-known/jwks.json` to the input when parsing fails.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const std = btoa(binary);
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deriveDefaultJwksUri(tokenEndpoint: string): string {
  try {
    const url = new URL(tokenEndpoint);
    return `${url.origin}/.well-known/jwks.json`;
  } catch {
    return tokenEndpoint.replace(/\/[^/]*$/, '') + '/.well-known/jwks.json';
  }
}

/**
 * Default expected `iss` and `aud` claims — frozen platform identifiers.
 * Rakomi-issued user-flow tokens carry `iss = aud = https://rakomi.com`
 * regardless of which subdomain or custom domain the request was routed
 * through (custom domain is routing only, not identity).
 *
 * Defaults remain enforced — the audience expectation is NOT made overridable
 * through a bypass; consumer-supplied override is for legitimate multi-issuer
 * test harnesses only.
 */
const RAKOMI_PLATFORM_ISSUER_DEFAULT = 'https://rakomi.com';
const RAKOMI_PLATFORM_AUDIENCE_DEFAULT = 'https://rakomi.com';
function deriveDefaultIssuer(_tokenEndpoint: string): string {
  return RAKOMI_PLATFORM_ISSUER_DEFAULT;
}

const REFRESH_TOKEN_PREFIX = 'v1:';

const REFRESH_BUFFER_SECONDS = 60;

export interface TokenRuntimeOptions {
  clientId: string;
  tenantId: string;
  tokenEndpoint: string;
  /** JWKS endpoint for offline access-token verification. Default: `<tokenEndpoint base>/.well-known/jwks.json`. */
  jwksUri?: string;
  /** TTL for the cached JWKS document. Default 24h, clamped to 7 days. */
  jwksTtlMs?: number;
  /** Expected `iss` and `aud` for jwtVerify (offline). When unset, verify only signature + exp. */
  expectedIssuer?: string;
  expectedAudience?: string | string[];
  storage: KeyValueStore;
  http: HttpClient;
  crypto: { digestSha256(input: Uint8Array): Promise<Uint8Array>; getRandomBytes(length: number): Promise<Uint8Array> };
  biometric?: BiometricGate;
  /** When true, refresh-token READ is biometric-gated. */
  biometricEnabled?: boolean;
  /** When true, biometric strict mode disables device passcode fallback. */
  biometricStrict?: boolean;
  /** Localized prompt for biometric reads. */
  biometricPrompt?: string;
  /** Receives FSM actions — runtime drives the reducer in the Provider. */
  dispatch: (action: MachineAction) => void;
  /**
 * Optional DPoP binding handle. When a
 * session is DPoP-bound, the refresh call attaches a fresh RFC 9449 proof. When
 * absent or unbound, refresh stays a plain Bearer call. One `DpopSession` per
 * logged-in session (one native keypair); never shared across sessions.
 */
  dpopSession?: DpopSession;
  /** Optional sink for retry telemetry / observability. */
  onEvent?: (event: { type: 'network_retry' | 'refresh_started' | 'refresh_succeeded' | 'refresh_failed' | 'biometric_failed' | 'dpop_refresh_failed'; metadata?: Record<string, unknown> }) => void;
  /** Time source — injected for tests. Default: Date.now. */
  now?: () => number;
  /** setTimeout — injected for tests. Default: globalThis.setTimeout. */
  setTimeout?: typeof setTimeout;
  /** clearTimeout — injected for tests. Default: globalThis.clearTimeout. */
  clearTimeout?: typeof clearTimeout;
}

export class TokenRuntime {
  private readonly clientId: string;
  private readonly tenantId: string;
  private readonly tokenEndpoint: string;
  private readonly storage: KeyValueStore;
  private readonly http: HttpClient;
  private readonly crypto: TokenRuntimeOptions['crypto'];
  private readonly biometric: BiometricGate | undefined;
  private readonly biometricEnabled: boolean;
  private readonly biometricStrict: boolean;
  private readonly biometricPrompt: string;
  private readonly dispatch: (action: MachineAction) => void;
  private readonly dpopSession: DpopSession | undefined;
  private readonly emitEvent: TokenRuntimeOptions['onEvent'];
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private storageKeyResolved: string | null = null;
  private jwksKeyResolved: string | null = null;
  private jwksCache: JwksCache | null = null;
  private readonly jwksUri: string;
  private readonly jwksTtlMs: number;
  private readonly expectedIssuer: string | undefined;
  private readonly expectedAudience: string | string[] | undefined;
  private accessToken: string | null = null;
  private expiresAtMs: number | null = null;
  private currentUser: UserResource | null = null;
  private currentSession: SessionResource | null = null;

  private refreshInFlight: Promise<boolean> | null = null;
  private refreshAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private offlineStaleCycles = 0;
  private static readonly MAX_OFFLINE_STALE_CYCLES = 3;

  private readonly submitNonces = new Map<string, number>();
  private static readonly NONCE_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_PENDING_NONCES = 100;

  constructor(options: TokenRuntimeOptions) {
    this.clientId = options.clientId;
    this.tenantId = options.tenantId;
    this.tokenEndpoint = options.tokenEndpoint;
    this.storage = options.storage;
    this.http = options.http;
    this.crypto = options.crypto;
    this.biometric = options.biometric;
    this.biometricEnabled = options.biometricEnabled ?? false;
    this.biometricStrict = options.biometricStrict ?? false;
    this.biometricPrompt = options.biometricPrompt ?? 'Authenticate to continue';
    this.dispatch = options.dispatch;
    this.dpopSession = options.dpopSession;
    this.emitEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.jwksUri = options.jwksUri ?? deriveDefaultJwksUri(options.tokenEndpoint);
    this.jwksTtlMs = options.jwksTtlMs ?? 24 * 60 * 60 * 1000;
    this.expectedIssuer = options.expectedIssuer ?? deriveDefaultIssuer(options.tokenEndpoint);
    this.expectedAudience = options.expectedAudience ?? RAKOMI_PLATFORM_AUDIENCE_DEFAULT;
  }

  /**
 * Issue a one-time submit nonce for an authentication ceremony.
 *
 * every public-surface `submitOAuthTokens` call MUST present a nonce
 * issued by an in-flight flow. Nonces are 32 bytes, base64url, single-use, 5-minute TTL.
 */
  async beginAuthFlow(): Promise<string> {
    const bytes = await this.crypto.getRandomBytes(32);
    const nonce = bytesToBase64Url(bytes);
    this.submitNonces.set(nonce, this.now() + TokenRuntime.NONCE_TTL_MS);
    this.gcExpiredNonces();
    while (this.submitNonces.size > TokenRuntime.MAX_PENDING_NONCES) {
      const oldest = this.submitNonces.keys().next().value;
      if (oldest === undefined) break;
      this.submitNonces.delete(oldest);
    }
    return nonce;
  }

  private gcExpiredNonces(): void {
    const cutoff = this.now();
    for (const [nonce, expiresAt] of this.submitNonces) {
      if (expiresAt < cutoff) this.submitNonces.delete(nonce);
    }
  }

  private consumeNonce(nonce: string): boolean {
    this.gcExpiredNonces();
    const entry = this.submitNonces.get(nonce);
    if (entry === undefined) return false;
    this.submitNonces.delete(nonce);
    return true;
  }

  /**
 * Validate a submit nonce — public for Provider-layer nonce gate.
 * Internal class paths (refresh, restore) bypass this; external consumer-facing
 * surfaces (`Provider.submitOAuthTokens`) MUST call this BEFORE invoking `setTokens`.
 */
  validateSubmitNonce(nonce: string): boolean {
    return this.consumeNonce(nonce);
  }

  /**
 * Persist tokens after a successful sign-in or refresh. Updates in-memory state,
 * writes refresh token to secure storage, and dispatches `SIGN_IN_SUCCESS` /
 * `REFRESH_SUCCESS` to the FSM.
 *
 * Internal API — the consumer-facing tokens-write surface is `Provider.submitOAuthTokens`,
 * which gates this with `validateSubmitNonce`.
 */
  async setTokens(response: OAuthTokenResponse, source: 'sign_in' | 'refresh' | 'restore' = 'sign_in'): Promise<void> {
    const user = decodeUser(response.access_token);
    if (!user) {
      this.dispatch({ type: 'SIGN_IN_FAILED', error: { code: 'SIGN_IN_FAILED', message: 'Invalid or missing JWT claims' } });
      return;
    }

    if (this.currentUser && this.currentUser.id !== user.id) {
      await this.clear({ code: 'SIGN_IN_FAILED', message: 'session_mismatch on token set' });
      return;
    }

    const sessionDecoded = decodeSession(response.access_token, response.expires_in);
    if (!sessionDecoded) {
      this.dispatch({ type: 'SIGN_IN_FAILED', error: { code: 'SIGN_IN_FAILED', message: 'Invalid session claims' } });
      return;
    }

    const clampedExpiresIn = Math.max(10, Math.min(86400, Math.floor(response.expires_in)));
    this.accessToken = response.access_token;
    this.expiresAtMs = this.now() + clampedExpiresIn * 1000;
    this.refreshAttempts = 0;
    this.currentUser = user;
    this.currentSession = { ...sessionDecoded, isExpiringSoon: false };

    if (response.refresh_token) {
      const key = await this.resolveStorageKey();
      await this.storage.setItem(key, REFRESH_TOKEN_PREFIX + response.refresh_token, {
        keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
        requireAuthentication: this.biometricEnabled,
        authenticationPrompt: this.biometricEnabled ? this.biometricPrompt : undefined,
      });
    }

    if (source === 'refresh') {
      this.dispatch({ type: 'REFRESH_SUCCESS', session: this.currentSession });
    } else if (source === 'sign_in') {
      this.dispatch({ type: 'SIGN_IN_SUCCESS', user, session: this.currentSession });
    }
  }

  /**
   * Public token getter — returns a `TokenResult` shape compatible with `useAuth().getToken`.
   * Refreshes proactively if within the refresh buffer; deduplicates concurrent callers.
   */
  getToken = async (): Promise<TokenResult> => {
    const valid = this.getValidAccessToken();
    if (valid) {
      const expiresIn = Math.max(0, Math.floor(((this.expiresAtMs ?? 0) - this.now()) / 1000));
      return { ok: true, token: valid, tokenType: 'Bearer', headers: {}, expiresIn };
    }
    const success = await this.performRefresh();
    if (!success || !this.accessToken || this.expiresAtMs === null) {
      return { ok: false, error: { code: 'REFRESH_FAILED', reason: 'expired', message: 'No valid token available' } };
    }
    const expiresIn = Math.max(0, Math.floor((this.expiresAtMs - this.now()) / 1000));
    return { ok: true, token: this.accessToken, tokenType: 'Bearer', headers: {}, expiresIn };
  };

  /**
   * Try to restore session from persisted refresh token. Called once on Provider mount.
   * Triggers a refresh — on success dispatches RESTORE_SUCCESS; on failure RESTORE_FAILED.
   */
  async restore(): Promise<boolean> {
    const success = await this.performRefresh({ duringRestore: true });
    if (success && this.currentUser && this.currentSession) {
      this.dispatch({ type: 'RESTORE_SUCCESS', user: this.currentUser, session: this.currentSession });
      return true;
    }
    this.dispatch({ type: 'RESTORE_FAILED' });
    return false;
  }

  /**
   * Foreground refresh — called by Provider AppState handler. Dispatches REFRESH_START
   * and kicks a single in-flight refresh. No-op if no refresh token / already in flight.
   */
  async refreshOnForeground(): Promise<void> {
    if (this.refreshInFlight) return;
    if (!this.currentUser) return;
    this.dispatch({ type: 'REFRESH_START' });
    await this.performRefresh();
  }

  /**
   * Clear all auth state. GDPR Art. 17 erasure.
   */
  async clear(error?: AuthError): Promise<void> {
    this.accessToken = null;
    this.expiresAtMs = null;
    this.currentUser = null;
    this.currentSession = null;
    this.refreshInFlight = null;
    this.refreshAttempts = 0;
    if (this.retryTimer) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      const key = await this.resolveStorageKey();
      await this.storage.removeItem(key);
    } catch {
    }
    if (error) {
      this.dispatch({ type: 'REFRESH_REVOKED', error });
    } else {
      this.dispatch({ type: 'SIGN_OUT' });
    }
  }

  /**
 * Verify a JWT against the cached JWKS (offline-capable).
 *
 * uses `jose.createLocalJWKSet` so verification is purely local once
 * the JWKS document has been fetched and cached. The cache is preloaded from `KeyValueStore`
 * on cold-start (slot `jwks_cache`) and refreshed on TTL miss; on persistent network failure
 * the stale-while-error fallback keeps verification working until the cached doc itself expires.
 */
  async verifyAccessToken(token: string): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: string }> {
    try {
      const cache = await this.getOrCreateJwksCache();
      const keySet = await cache.getKeySet();
      const result = await jwtVerify(token, keySet, {
        issuer: this.expectedIssuer,
        audience: this.expectedAudience,
        algorithms: ['RS256'],
      });
      return { ok: true, payload: result.payload as Record<string, unknown> };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'verify failed' };
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
    this.refreshInFlight = null;
  }

  private async resolveStorageKey(): Promise<string> {
    if (this.storageKeyResolved) return this.storageKeyResolved;
    this.storageKeyResolved = await deriveTenantStorageKey(this.crypto, this.tenantId, 'refresh_token');
    return this.storageKeyResolved;
  }

  private async resolveJwksKey(): Promise<string> {
    if (this.jwksKeyResolved) return this.jwksKeyResolved;
    this.jwksKeyResolved = await deriveTenantStorageKey(this.crypto, this.tenantId, 'jwks_cache');
    return this.jwksKeyResolved;
  }

  private async getOrCreateJwksCache(): Promise<JwksCache> {
    if (this.jwksCache) return this.jwksCache;
    const key = await this.resolveJwksKey();
    let initial: { document: JwksDocument; fetchedAt: number } | undefined;
    try {
      const raw = await this.storage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as { document?: JwksDocument; fetchedAt?: number };
        if (parsed.document && typeof parsed.fetchedAt === 'number') {
          initial = { document: parsed.document, fetchedAt: parsed.fetchedAt };
        }
      }
    } catch {
    }
    this.jwksCache = createJwksCache({
      ttlMs: this.jwksTtlMs,
      fetchJwks: async () => {
        const response = await this.http.fetch(this.jwksUri, { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) {
          throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
        }
        return (await response.json()) as JwksDocument;
      },
      initial,
      onFetched: (document, fetchedAt) => {
        void this.storage.setItem(key, JSON.stringify({ document, fetchedAt })).catch(() => undefined);
      },
    });
    return this.jwksCache;
  }

  private getValidAccessToken(): string | null {
    if (!this.accessToken || this.expiresAtMs === null) return null;
    if (this.now() >= this.expiresAtMs - REFRESH_BUFFER_SECONDS * 1000) return null;
    return this.accessToken;
  }

  private async performRefresh(opts: { duringRestore?: boolean } = {}): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh(opts).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(opts: { duringRestore?: boolean }): Promise<boolean> {
    if (this.destroyed) return false;
    this.emitEvent?.({ type: 'refresh_started' });

    if (this.biometricEnabled && this.biometric) {
      const available = await this.biometric.isAvailable();
      if (!available) {
        this.emitEvent?.({ type: 'biometric_failed', metadata: { reason: 'unavailable' } });
        if (!opts.duringRestore) {
          await this.clear({ code: 'REFRESH_FAILED', reason: 'revoked', message: 'Biometric unavailable' });
        }
        return false;
      }
      const result = await this.biometric.authenticate({ promptMessage: this.biometricPrompt, strict: this.biometricStrict });
      if (!result.success) {
        this.emitEvent?.({ type: 'biometric_failed', metadata: { reason: result.reason } });
        if (!opts.duringRestore) {
          if (result.reason === 'lockout' || result.reason === 'not_enrolled') {
            await this.clear({ code: 'REFRESH_FAILED', reason: 'revoked', message: `Biometric ${result.reason}` });
          }
        }
        return false;
      }
    }

    const key = await this.resolveStorageKey();
    let raw: string | null;
    try {
      raw = await this.storage.getItem(key, {
        requireAuthentication: this.biometricEnabled,
        authenticationPrompt: this.biometricEnabled ? this.biometricPrompt : undefined,
      });
    } catch {
      raw = null;
    }

    if (!raw) {
      this.emitEvent?.({ type: 'refresh_failed', metadata: { reason: 'no_refresh_token' } });
      return false;
    }
    if (!raw.startsWith(REFRESH_TOKEN_PREFIX)) {
      await this.storage.removeItem(key).catch(() => undefined);
      this.emitEvent?.({ type: 'refresh_failed', metadata: { reason: 'invalid_storage_prefix' } });
      return false;
    }
    const refreshToken = raw.slice(REFRESH_TOKEN_PREFIX.length);

    if (this.dpopSession?.isBound) {
      const dResult = await refreshWithDpop({
        http: this.http,
        tokenEndpoint: this.tokenEndpoint,
        refreshToken,
        clientId: this.clientId,
        dpopSession: this.dpopSession,
      });
      if (!dResult.ok) {
        return this.handleDpopRefreshFailure(dResult.error, opts.duringRestore ?? false);
      }
      this.emitEvent?.({ type: 'refresh_succeeded' });
      this.refreshAttempts = 0;
      this.offlineStaleCycles = 0;
      await this.setTokens(dResult.tokens, opts.duringRestore ? 'restore' : 'refresh');
      return true;
    }

    const result = await refreshAccessToken({
      http: this.http,
      tokenEndpoint: this.tokenEndpoint,
      refreshToken,
      clientId: this.clientId,
    });

    if (!result.ok) {
      this.emitEvent?.({ type: 'refresh_failed', metadata: { code: result.error.code } });
      if (this.isAuthError(result.error)) {
        await this.clear(result.error);
        return false;
      }
      return this.scheduleRetry(result.error, opts.duringRestore ?? false);
    }

    this.emitEvent?.({ type: 'refresh_succeeded' });
    this.refreshAttempts = 0;
    this.offlineStaleCycles = 0;
    await this.setTokens(result.tokens, opts.duringRestore ? 'restore' : 'refresh');
    return true;
  }

  private isAuthError(error: AuthError): boolean {
    return error.code === 'REFRESH_FAILED' && (error.reason === 'expired' || error.reason === 'revoked');
  }

  /**
 * Map a DPoP-refresh failure (three-class taxonomy) onto the FSM. The
 * distinct `code` is emitted as telemetry, so consumers can tell an
 * `auth/invalid_dpop_proof` spike apart from `auth/invalid_refresh_token`
 * (the classes are kept distinct deliberately).
 */
  private async handleDpopRefreshFailure(error: DpopRefreshError, duringRestore: boolean): Promise<boolean> {
    this.emitEvent?.({ type: 'dpop_refresh_failed', metadata: { code: error.code } });
    if (error.class === 'network') {
      return this.scheduleRetry({ code: 'REFRESH_FAILED', reason: 'network', message: error.message }, duringRestore);
    }
    if (error.class === 'dpop_prover_unavailable') {
      this.emitEvent?.({ type: 'refresh_failed', metadata: { reason: 'dpop_prover_unavailable' } });
      return false;
    }
    await this.clear({ code: 'REFRESH_FAILED', reason: 'revoked', message: error.message });
    return false;
  }

  private scheduleRetry(error: AuthError, duringRestore: boolean): boolean {
    if (this.refreshAttempts >= RETRY_DELAYS_MS.length) {
      if (!duringRestore && this.accessToken && this.expiresAtMs !== null && this.now() < this.expiresAtMs) {
        this.refreshAttempts = 0;
        this.offlineStaleCycles += 1;
        if (this.offlineStaleCycles >= TokenRuntime.MAX_OFFLINE_STALE_CYCLES) {
          this.offlineStaleCycles = 0;
          void this.clear({ code: 'REFRESH_FAILED', reason: 'revoked', message: 'Refresh chronically failing — session lost' });
          return false;
        }
        this.dispatch({ type: 'OFFLINE_STALE' });
        return false;
      }
      void this.clear({ code: 'REFRESH_FAILED', reason: 'network', message: 'Refresh exhausted retries' });
      return false;
    }
    const delay = RETRY_DELAYS_MS[this.refreshAttempts]!;
    this.refreshAttempts++;
    this.emitEvent?.({ type: 'network_retry', metadata: { delayMs: delay, attempt: this.refreshAttempts } });
    if (!duringRestore) {
      this.dispatch({ type: 'REFRESH_NETWORK_ERROR', error });
    }

    if (this.retryTimer) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      void this.performRefresh();
    }, delay);
    return false;
  }
}
