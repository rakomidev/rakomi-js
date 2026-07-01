/**
 * TokenManager — manages token lifecycle for @rakomi/react.
 *
 * Non-React class (pure logic). Connected to React via useSyncExternalStore.
 *
 * Security invariants:
 * - Access token: in-memory only, NEVER persisted
 * - Refresh token: in configured storage adapter
 * - Token values NEVER logged
 * - Auth errors (401/403/invalid_grant/revoked): clear immediately, ZERO retry
 * - Network errors (5xx/offline): retry 3x with backoff (2s, 8s, 30s)
 * - BroadcastChannel: signals only (never token values)
 * - User ID continuity check: mismatch on refresh → session_mismatch + clear
 * - GDPR Art. 17: clear() erases ALL state including event log
 */

import type { EventLog } from './event-log.js';
import { decodeJwtPayload, decodeSession,decodeUser } from './jwt-decode.js';
import { sdkFetch } from './lib/fetch-client.js';
import { refreshToken as doRefreshToken } from './oauth/token.js';
import type { TokenStorage } from './storage.js';
import type { TabSync } from './tab-sync.js';
import type { AuthError, AuthState, HasParams, InitialAuthState, OAuthTokenResponse, SignInOptions, SignInResult, SwitchOrgResult, TokenResult, UserResource } from './types.js';

/**
 * Create a `has()` authorization check bound to a user's RBAC claims.
 * Wildcard-aware: user with `posts:*` passes `has({ permission: 'posts:read' })`.
 */
function createHasFunction(user: UserResource): (params: HasParams) => boolean {
  return (params: HasParams): boolean => {
    const knownKeys = new Set(['permission', 'role']);
    for (const key of Object.keys(params)) {
      if (!knownKeys.has(key)) {
        throw new TypeError(`${key} check not yet supported. Available in a future release.`);
      }
    }

    if (!params.permission && !params.role) {
      return false;
    }

    if (params.permission) {
      const permissions = user.permissions ?? [];
      if (!permissions.includes(params.permission)) {
        const [namespace] = params.permission.split(':');
        if (!namespace || !permissions.includes(`${namespace}:*`)) {
          return false;
        }
      }
    }

    if (params.role) {
      const roles = user.roles ?? [];
      if (!roles.includes(params.role)) {
        return false;
      }
    }

    return true;
  };
}

type Subscriber = () => void;

/** Retry delays for network errors: 2s, 8s, 30s */
const RETRY_DELAYS_MS = [2000, 8000, 30000] as const;

/**
 * Adaptive refresh buffer: 10% of expires_in, clamped to [10s, 60s].
 * Handles short-lived tokens (e.g., 90s) without always burning 60s of TTL.
 */
function refreshBuffer(expiresIn: number): number {
  return Math.max(10, Math.min(60, Math.floor(expiresIn * 0.1)));
}

export interface TokenManagerOptions {
  clientId: string;
  baseUrl: string;
  storage: TokenStorage;
  tabSync: TabSync;
  eventLog: EventLog;
  initialState?: InitialAuthState;
  sessionTimeout?: number;
  /** Minutes before expiry when isExpiringSoon becomes true. Default: 5. Range: [1, 60]. */
  expiringThresholdMinutes?: number;
}

/** Max safe setTimeout delay: 2^31-1 ms (~24.8 days). Larger values fire immediately. */
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

export class TokenManager {
  private readonly clientId: string;
  private readonly baseUrl: string;
  private storage: TokenStorage;
  private readonly tabSync: TabSync;
  private readonly eventLog: EventLog;
  private readonly initialState?: InitialAuthState;
  private readonly sessionTimeout?: number;

  private readonly refreshKey: string;
  private readonly stateKey: string;

  private accessToken: string | null = null;
  private expiresAt: number | null = null;

  private refreshPromise: Promise<boolean> | null = null;
  private refreshAttempts = 0;
  private lastRefreshTime = 0;

  private refreshTimerId: ReturnType<typeof setTimeout> | null = null;
  private retryTimerId: ReturnType<typeof setTimeout> | null = null;
  private sessionCheckInterval: ReturnType<typeof setInterval> | null = null;

  private isOffline = false;

  private expiryTimerId: ReturnType<typeof setTimeout> | null = null;
  private isExpiringSoon = false;
  private maxLifetimeExpiresAtMs: number | undefined = undefined;
  private readonly expiringThresholdMinutes: number;

  private lastInteractionTime = Date.now();
  private lastInteractionUpdate = 0;
  private interactionListenersAdded = false;

  private readonly subscribers: Set<Subscriber> = new Set();
  private cachedSnapshot: AuthState;
  private readonly _serverSnapshot: AuthState;

  private readonly _signInDelegate: (options?: SignInOptions) => Promise<SignInResult>;
  private readonly _signOutDelegate: () => Promise<void>;
  private readonly _getTokenDelegate: () => Promise<TokenResult>;
  private readonly _switchOrgDelegate: (orgId: string | null) => Promise<SwitchOrgResult>;

  private unsubscribeTabSync: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private pageshowHandler: ((e: PageTransitionEvent) => void) | null = null;

  constructor(options: TokenManagerOptions) {
    this.clientId = options.clientId;
    this.baseUrl = options.baseUrl;
    this.storage = options.storage;
    this.tabSync = options.tabSync;
    this.eventLog = options.eventLog;
    this.initialState = options.initialState;
    this.sessionTimeout = options.sessionTimeout;

    const rawThreshold = options.expiringThresholdMinutes ?? 5;
    if (rawThreshold < 1 || rawThreshold > 60) {
      console.warn(`[Rakomi] expiringThresholdMinutes=${rawThreshold} is out of range [1, 60]. Clamping.`);
    }
    this.expiringThresholdMinutes = Math.max(1, Math.min(60, rawThreshold));

    this.refreshKey = `rakomi:${this.clientId}:refresh_token`;
    this.stateKey = `rakomi:${this.clientId}:oauth_state`;

    this._signInDelegate = (options?: SignInOptions) => this.signIn(options);
    this._signOutDelegate = () => this.signOut();
    this._getTokenDelegate = () => this.getToken();
    this._switchOrgDelegate = (orgId: string | null) => this.switchOrganization(orgId);

    this._serverSnapshot = this.makeSignedOutSnapshot();

    this.validateBaseUrl();

    this.cachedSnapshot = this.makeLoadingSnapshot();

    this.setupTabSync();
    this.setupVisibilityListener();
    this.setupOnlineOfflineListeners();
    this.setupBfcacheHandler();
    if (this.sessionTimeout) {
      this.setupSessionTimeout();
    }
  }

  private validateBaseUrl(): void {
    try {
      const url = new URL(this.baseUrl);
      const isLocalhost =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]';
      if (url.protocol === 'http:' && !isLocalhost) {
        throw new Error('baseUrl must use HTTPS for non-localhost origins');
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('HTTPS')) {
        throw err;
      }
    }
  }

  private makeLoadingSnapshot(): AuthState {
    return Object.freeze({
      isLoaded: false as const,
      isSignedIn: undefined,
      userId: undefined,
      user: undefined,
      sessionId: undefined,
      error: null,
      signIn: this._signInDelegate,
      signOut: this._signOutDelegate,
      getToken: this._getTokenDelegate,
    });
  }

  private makeSignedOutSnapshot(error: AuthError | null = null): AuthState {
    return Object.freeze({
      isLoaded: true as const,
      isSignedIn: false as const,
      userId: null,
      user: null,
      sessionId: null,
      error,
      signIn: this._signInDelegate,
      signOut: this._signOutDelegate,
      getToken: this._getTokenDelegate,
    });
  }

  private makeSignedInSnapshot(token: string, expiresIn: number): AuthState {
    const user = decodeUser(token);
    const session = decodeSession(token, expiresIn);
    if (!user || !session) {
      return this.makeSignedOutSnapshot({
        code: 'SIGN_IN_FAILED',
        message: 'Invalid or missing required JWT claims',
      });
    }
    return Object.freeze({
      isLoaded: true as const,
      isSignedIn: true as const,
      userId: user.id,
      user: user as UserResource & Record<never, never>,
      sessionId: session.id,
      error: null as AuthError | null,
      has: createHasFunction(user),
      isExpiringSoon: this.isExpiringSoon,
      signIn: this._signInDelegate,
      signOut: this._signOutDelegate,
      getToken: this._getTokenDelegate,
      switchOrganization: this._switchOrgDelegate,
    });
  }

  /**
   * Store tokens after successful sign-in, code exchange, or refresh.
   * Access token: in-memory only. Refresh token: persisted in storage.
   * Broadcasts TOKEN_REFRESHED signal to other tabs (signal only, no token value).
   */
  async setTokens(response: OAuthTokenResponse): Promise<void> {
    const prevUserId = this.accessToken ? decodeUser(this.accessToken)?.id ?? null : null;
    const newUserId = decodeUser(response.access_token)?.id ?? null;

    if (prevUserId !== null && newUserId !== null && prevUserId !== newUserId) {
      this.eventLog.push({
        type: 'session_mismatch',
        severity: 'security',
        metadata: { reason: 'user_id_changed_on_token_set' },
      });
      await this.clear();
      return;
    }

    const clampedExpiresIn = Math.max(10, Math.min(86400, Math.floor(response.expires_in)));

    this.accessToken = response.access_token;
    this.expiresAt = Date.now() + clampedExpiresIn * 1000;
    this.lastRefreshTime = Date.now();
    this.refreshAttempts = 0;

    const jwtPayload = decodeJwtPayload(response.access_token);
    const maxLifetimeExpSeconds = typeof jwtPayload?.['session_max_lifetime_exp'] === 'number'
      ? (jwtPayload['session_max_lifetime_exp'] as number)
      : undefined;
    this.maxLifetimeExpiresAtMs = maxLifetimeExpSeconds !== undefined
      ? maxLifetimeExpSeconds * 1000
      : undefined;

    this.isExpiringSoon = false;

    if (response.refresh_token) {
      await this.storage.setItem(this.refreshKey, 'v1:' + response.refresh_token);
    }

    this.tabSync.broadcast({ type: 'TOKEN_REFRESHED' });

    this.cachedSnapshot = this.makeSignedInSnapshot(this.accessToken, clampedExpiresIn);
    this.notifySubscribers();
    this.startAutoRefresh(clampedExpiresIn);
    this.scheduleExpiryWarning(this.expiresAt, this.maxLifetimeExpiresAtMs);

    this.eventLog.push({ type: 'token_received', severity: 'info' });
  }

  /**
   * Switch storage adapter (for "Keep me signed in" feature).
   * Migrates existing refresh token from old to new storage, then removes from old.
   * MUST be called BEFORE setTokens() — ordering critical.
   */
  async setPersistence(newStorage: TokenStorage): Promise<void> {
    if (newStorage === this.storage) return;

    const existing = await this.storage.getItem(this.refreshKey);
    const oldStorage = this.storage;
    this.storage = newStorage;

    if (existing) {
      await newStorage.setItem(this.refreshKey, existing);
      await oldStorage.removeItem(this.refreshKey);
    }
  }

  /**
   * Synchronous access token getter (in-memory, no storage I/O).
   * Returns null if token is missing or expired.
   */
  getAccessToken(): string | null {
    if (!this.accessToken || this.expiresAt === null) return null;
    if (Date.now() >= this.expiresAt) return null;
    return this.accessToken;
  }

  /**
   * Get a valid token, refreshing proactively if within the refresh buffer.
   * Concurrent calls are deduplicated to a single in-flight refresh Promise.
   */
  async getValidToken(): Promise<string | null> {
    if (this.accessToken && this.expiresAt !== null) {
      if (Date.now() < this.expiresAt - 60_000) {
        return this.accessToken;
      }
    }

    await this.performRefresh();
    return this.accessToken;
  }

  /**
   * Restore session from storage on provider mount.
   * Transitions from isLoaded:false → isLoaded:true.
   */
  async restore(): Promise<boolean> {
    this.eventLog.push({ type: 'restore_attempted', severity: 'info' });

    const stored = await this.storage.getItem(this.refreshKey);
    if (!stored) {
      this.cachedSnapshot = this.makeSignedOutSnapshot();
      this.notifySubscribers();
      return false;
    }

    const success = await this.performRefresh();
    if (success) {
      this.eventLog.push({ type: 'restore_succeeded', severity: 'info' });
    } else {
      this.eventLog.push({ type: 'restore_failed', severity: 'warning' });
      this.cachedSnapshot = this.makeSignedOutSnapshot();
      this.notifySubscribers();
    }
    return success;
  }

  /**
   * Start background auto-refresh timer.
   * Fires at expires_in - refreshBuffer(expires_in) seconds.
   */
  startAutoRefresh(expiresIn: number): void {
    this.stopAutoRefresh();
    if (this.isOffline) return;
    const buffer = refreshBuffer(expiresIn);
    const delayMs = Math.max(0, (expiresIn - buffer) * 1000);
    this.refreshTimerId = setTimeout(() => {
      void this.performRefresh();
    }, delayMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimerId !== null) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }

  /**
   * GDPR Art. 17 compliant erasure of all auth state.
   * Clears: access token, refresh token from storage, PKCE state, event log, timers.
   * Broadcasts SIGNED_OUT signal to other tabs.
   */
  async clear(error: AuthError | null = null): Promise<void> {
    this.accessToken = null;
    this.expiresAt = null;
    this.refreshPromise = null;
    this.refreshAttempts = 0;

    this.stopAutoRefresh();
    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
    if (this.sessionCheckInterval !== null) {
      clearInterval(this.sessionCheckInterval);
      this.sessionCheckInterval = null;
    }
    this.clearExpiryTimer();
    this.isExpiringSoon = false;
    this.maxLifetimeExpiresAtMs = undefined;

    await this.storage.removeItem(this.refreshKey);

    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(this.stateKey);
      } catch {
      }
    }

    this.eventLog.clear();

    this.tabSync.broadcast({ type: 'SIGNED_OUT' });

    this.cachedSnapshot = this.makeSignedOutSnapshot(error);
    this.notifySubscribers();
  }

  /**
   * Surface sign_in_failed / code exchange error to auth.error in the signed-out snapshot.
   * Called by context.tsx when signIn() fails so consumers can read auth.error.
   */
  setSignedOutWithError(error: AuthError): void {
    this.cachedSnapshot = this.makeSignedOutSnapshot(error);
    this.notifySubscribers();
  }

  /**
   * Tear down all timers and event listeners.
   * Call from provider useEffect cleanup (unmount).
   */
  destroy(): void {
    this.stopAutoRefresh();
    this.clearExpiryTimer();

    if (this.retryTimerId !== null) {
      clearTimeout(this.retryTimerId);
      this.retryTimerId = null;
    }
    if (this.sessionCheckInterval !== null) {
      clearInterval(this.sessionCheckInterval);
      this.sessionCheckInterval = null;
    }
    if (this.unsubscribeTabSync) {
      this.unsubscribeTabSync();
      this.unsubscribeTabSync = null;
    }

    if (typeof window !== 'undefined') {
      if (this.visibilityHandler) {
        document.removeEventListener('visibilitychange', this.visibilityHandler);
        this.visibilityHandler = null;
      }
      if (this.onlineHandler) {
        window.removeEventListener('online', this.onlineHandler);
        this.onlineHandler = null;
      }
      if (this.offlineHandler) {
        window.removeEventListener('offline', this.offlineHandler);
        this.offlineHandler = null;
      }
      if (this.pageshowHandler) {
        window.removeEventListener('pageshow', this.pageshowHandler);
        this.pageshowHandler = null;
      }
      if (this.interactionListenersAdded) {
        window.removeEventListener('mousemove', this.handleInteraction);
        window.removeEventListener('keydown', this.handleInteraction);
        window.removeEventListener('touchstart', this.handleInteraction);
        this.interactionListenersAdded = false;
      }
    }

    this.subscribers.clear();
  }

  /**
   * Subscribe to store changes — for useSyncExternalStore.
   * Returns an unsubscribe function.
   */
  readonly subscribe = (callback: Subscriber): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  /**
   * CRITICAL: returns the SAME cached reference if state has not changed.
   * useSyncExternalStore calls this on every render — returning a new object
   * every time causes infinite re-render loops.
   */
  readonly getSnapshot = (): AuthState => {
    return this.cachedSnapshot;
  };

  /**
   * Server snapshot for SSR hydration.
   * Returns the SAME stable reference on every call. useSyncExternalStore requires
   * referential equality across all subscribers in a single server render pass —
   * creating a new object per call causes hydration mismatches in concurrent SSR.
   */
  readonly getServerSnapshot = (): AuthState => {
    return this._serverSnapshot;
  };

  /**
   * Initiate sign-in. Overridden by RakomiProvider context after construction.
   * Stub returns complete to avoid TypeScript errors before provider overrides.
   */

  signIn: (options?: SignInOptions) => Promise<SignInResult> = (_options?: SignInOptions): Promise<SignInResult> => {
    return Promise.resolve({ status: 'complete' as const });
  };

  /**
   * Sign out — clears local state and broadcasts to other tabs.
   * Best-effort /oauth/revoke is handled by context.tsx.
   */
  signOut = (): Promise<void> => {
    return this.clear();
  };

  /**
   * Get a valid access token wrapped in TokenResult (DPoP-ready — RFC 9449).
   */
  getToken = async (): Promise<TokenResult> => {
    const token = await this.getValidToken();
    if (!token || this.expiresAt === null) {
      return {
        ok: false,
        error: { code: 'REFRESH_FAILED', reason: 'expired', message: 'No valid token available' },
      };
    }
    const expiresIn = Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
    return { ok: true, token, tokenType: 'Bearer', headers: {}, expiresIn };
  };

  switchOrganization = async (orgId: string | null): Promise<SwitchOrgResult> => {
    const token = this.accessToken;
    if (!token) {
      return { status: 'error', error: { code: 'SIGN_IN_FAILED', message: 'Not authenticated' } };
    }

    try {
      const response = await sdkFetch(`${this.baseUrl}/v1/organizations/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.clientId,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ org_id: orgId }),
      });

      if (response.ok) {
        const data = await response.json() as { access_token: string; expires_in: number; token_type: string };
        await this.setTokens({ access_token: data.access_token, expires_in: data.expires_in, token_type: data.token_type });
        return { status: 'complete' };
      }

      if (response.status === 403) {
        const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        if (code === 'organization/mfa_required') return { status: 'mfa_required' };
        if (code === 'organization/sso_required') return { status: 'sso_required' };
      }

      return { status: 'error', error: { code: 'NETWORK_ERROR', message: 'Organization switch failed' } };
    } catch {
      return { status: 'error', error: { code: 'NETWORK_ERROR', message: 'Network error during org switch' } };
    }
  };

  getEventLog() {
    return this.eventLog.getAll();
  }

  private async performRefresh(): Promise<boolean> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async doRefresh(): Promise<boolean> {
    const raw = await this.storage.getItem(this.refreshKey);
    if (!raw) {
      if (this.cachedSnapshot.isLoaded === false || this.cachedSnapshot.isSignedIn === true) {
        this.cachedSnapshot = this.makeSignedOutSnapshot();
        this.notifySubscribers();
      }
      return false;
    }

    if (!raw.startsWith('v1:')) {
      this.eventLog.push({ type: 'restore_failed', severity: 'warning', metadata: { reason: 'invalid_storage_prefix' } });
      await this.clear();
      return false;
    }
    const storedRefresh = raw.slice(3);

    this.eventLog.push({ type: 'refresh_started', severity: 'info' });
    const startTime = Date.now();

    const { acquired, release } = await this.tabSync.acquireRefreshLock();

    if (!acquired) {
      this.eventLog.push({ type: 'lock_timeout', severity: 'warning' });
      return false;
    }

    this.eventLog.push({ type: 'lock_acquired', severity: 'info' });

    try {
      const result = await doRefreshToken({
        baseUrl: this.baseUrl,
        clientId: this.clientId,
        refreshToken: storedRefresh,
      });

      release();
      const duration = Date.now() - startTime;

      if (!result.ok) {
        this.eventLog.push({ type: 'refresh_failed', severity: 'warning', duration, error: result.error });

        if (this.isAuthError(result.error)) {
          await this.clear();
          return false;
        }

        return this.scheduleRetry(result.error);
      }

      this.eventLog.push({ type: 'refresh_succeeded', severity: 'info', duration });
      this.refreshAttempts = 0;

      await this.setTokens(result.data);
      return true;
    } catch (err) {
      release();
      this.eventLog.push({ type: 'refresh_failed', severity: 'warning' });
      const error: AuthError = {
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Unexpected error during token refresh',
      };
      return this.scheduleRetry(error);
    }
  }

  /**
   * Determine if an error is an auth error (definitively revoked/expired).
   * Auth errors: ZERO retry — token cannot be recovered.
   * Network errors: retry 3x.
   */
  private isAuthError(error: AuthError): boolean {
    if (error.code === 'REFRESH_FAILED') {
      return error.reason === 'expired' || error.reason === 'revoked';
    }
    return false;
  }

  /**
   * Schedule a retry with exponential backoff.
   * Keeps isSignedIn: true with stale token so developer can show "Reconnecting..." UI.
   * After 3 retries, clears tokens and sets isSignedIn: false.
   */
  private scheduleRetry(error: AuthError): boolean {
    if (this.refreshAttempts >= RETRY_DELAYS_MS.length) {
      void this.clear();
      return false;
    }

    const delay = RETRY_DELAYS_MS[this.refreshAttempts]!;
    this.refreshAttempts++;

    const retryError: AuthError = {
      code: 'REFRESH_FAILED',
      reason: 'network',
      message: `Refresh failed, retrying in ${delay / 1000}s (attempt ${this.refreshAttempts}/3)`,
    };

    this.eventLog.push({ type: 'network_retry', severity: 'warning', error: retryError });

    if (this.cachedSnapshot.isSignedIn === true) {
      const prev = this.cachedSnapshot;
      this.cachedSnapshot = Object.freeze({
        isLoaded: true as const,
        isSignedIn: true as const,
        userId: prev.userId,
        user: prev.user,
        sessionId: prev.sessionId,
        error: retryError as AuthError | null,
        has: prev.has,
        isExpiringSoon: this.isExpiringSoon,
        signIn: this._signInDelegate,
        signOut: this._signOutDelegate,
        getToken: this._getTokenDelegate,
        switchOrganization: this._switchOrgDelegate,
      });
      this.notifySubscribers();
    }

    this.retryTimerId = setTimeout(() => {
      this.retryTimerId = null;
      if (!this.isOffline) {
        void this.performRefresh();
      }
    }, delay);

    void error;
    return false;
  }

  private setupTabSync(): void {
    this.unsubscribeTabSync = this.tabSync.onMessage((message) => {
      if (message.type === 'TOKEN_REFRESHED') {
        this.eventLog.push({
          type: 'tab_sync_received',
          severity: 'info',
          metadata: { event: 'TOKEN_REFRESHED' },
        });
        if (!this.getAccessToken()) {
          void this.performRefresh();
        } else if (this.isExpiringSoon) {
          this.isExpiringSoon = false;
          if (this.cachedSnapshot.isSignedIn === true) {
            const expiresIn = this.expiresAt
              ? Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000))
              : 0;
            this.cachedSnapshot = this.makeSignedInSnapshot(this.accessToken!, expiresIn);
            this.notifySubscribers();
          }
        }
      } else if (message.type === 'SIGNED_OUT') {
        this.eventLog.push({
          type: 'tab_sync_received',
          severity: 'info',
          metadata: { event: 'SIGNED_OUT' },
        });
        void this.clear();
      }
    });
  }

  /**
   * Clear the expiry warning timer. Safe to call multiple times.
   */
  private clearExpiryTimer(): void {
    if (this.expiryTimerId !== null) {
      clearTimeout(this.expiryTimerId);
      this.expiryTimerId = null;
    }
  }

  /**
   * Schedule (or re-schedule) the centralized expiry warning timer.
   *
   * Called from setTokens() after every token set/refresh.
   * SSR-safe: setTimeout is only called in browser environments.
   *
   * Guarantees:
   * - Single timer instance regardless of how many useSession() consumers exist
   * - Timer clamp: delay > 2^31-1 ms is clamped to MAX_SAFE_TIMEOUT_MS (prevents overflow)
   * - Immediate case: if already past threshold, state updates immediately (no async)
   * - AuthEvent emitted ONCE per session lifetime (in both immediate and delayed paths)
   */
  private scheduleExpiryWarning(expiresAtMs: number, maxLifetimeExpiresAtMs?: number): void {
    if (typeof window === 'undefined') return;

    this.clearExpiryTimer();

    const thresholdMs = this.expiringThresholdMinutes * 60 * 1000;
    const effectiveExpiresAt = Math.min(expiresAtMs, maxLifetimeExpiresAtMs ?? Infinity);
    const nowMs = Date.now();
    const delay = effectiveExpiresAt - nowMs - thresholdMs;

    const reason: 'token_expiry' | 'max_lifetime' =
      (maxLifetimeExpiresAtMs !== undefined && maxLifetimeExpiresAtMs <= expiresAtMs)
        ? 'max_lifetime'
        : 'token_expiry';

    const fire = () => {
      const remainingMs = effectiveExpiresAt - Date.now() - thresholdMs;
      if (remainingMs > 0) {
        this.expiryTimerId = setTimeout(() => {
          this.expiryTimerId = null;
          fire();
        }, Math.min(remainingMs, MAX_SAFE_TIMEOUT_MS));
        return;
      }

      this.isExpiringSoon = true;
      if (this.cachedSnapshot.isSignedIn === true && this.accessToken) {
        const currentExpiresIn = this.expiresAt
          ? Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000))
          : 0;
        this.cachedSnapshot = this.makeSignedInSnapshot(this.accessToken, currentExpiresIn);
        this.notifySubscribers();
      }
      this.eventLog.push({
        type: 'session_expiring_soon',
        severity: 'warning',
        metadata: { reason },
      });
    };

    if (delay <= 0) {
      fire();
      return;
    }

    this.expiryTimerId = setTimeout(() => {
      this.expiryTimerId = null;
      fire();
    }, Math.min(delay, MAX_SAFE_TIMEOUT_MS));
  }

  private setupVisibilityListener(): void {
    if (typeof document === 'undefined') return;

    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;

      if (this.accessToken && this.expiresAt !== null) {
        const remaining = Math.floor((this.expiresAt - Date.now()) / 1000);
        const buffer = refreshBuffer(remaining);
        if (remaining <= buffer) {
          void this.performRefresh();
        }
      } else if (!this.accessToken) {
        void this.restore();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private setupOnlineOfflineListeners(): void {
    if (typeof window === 'undefined') return;

    this.offlineHandler = () => {
      this.isOffline = true;
      this.stopAutoRefresh();
    };

    this.onlineHandler = () => {
      this.isOffline = false;
      void this.performRefresh();
    };

    window.addEventListener('offline', this.offlineHandler);
    window.addEventListener('online', this.onlineHandler);
  }

  private setupBfcacheHandler(): void {
    if (typeof window === 'undefined') return;

    this.pageshowHandler = (e: PageTransitionEvent) => {
      if (e.persisted) {
        this.eventLog.push({ type: 'bfcache_restore', severity: 'info' });
        void this.performRefresh();
      }
    };

    window.addEventListener('pageshow', this.pageshowHandler);
  }

  /**
   * Interaction handler — debounced to at most once per minute.
   * Arrow function for stable reference (add/remove same listener).
   */
  private readonly handleInteraction = (): void => {
    const now = Date.now();
    if (now - this.lastInteractionUpdate > 60_000) {
      this.lastInteractionTime = now;
      this.lastInteractionUpdate = now;
    }
  };

  private setupSessionTimeout(): void {
    if (!this.sessionTimeout || typeof window === 'undefined') return;

    window.addEventListener('mousemove', this.handleInteraction, { passive: true });
    window.addEventListener('keydown', this.handleInteraction, { passive: true });
    window.addEventListener('touchstart', this.handleInteraction, { passive: true });
    this.interactionListenersAdded = true;

    this.sessionCheckInterval = setInterval(() => {
      if (!this.accessToken) return;
      const inactiveMs = Date.now() - this.lastInteractionTime;
      if (inactiveMs > this.sessionTimeout! * 60_000) {
        this.eventLog.push({
          type: 'signed_out',
          severity: 'info',
          metadata: { reason: 'inactivity_timeout' },
        });
        void this.signOut();
      }
    }, 60_000);
  }

  private notifySubscribers(): void {
    for (const subscriber of this.subscribers) {
      subscriber();
    }
  }
}
