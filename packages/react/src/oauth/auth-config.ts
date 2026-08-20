/**
 * AuthConfigManager — centralized config fetch + cache (parallel to TokenManager).
 * Fetches GET /v1/auth/config, caches in sessionStorage.
 * Lazy initialization: does NOT fetch on RakomiProvider mount.
 * Components read via useAuthConfig() hook — uses useSyncExternalStore.
 */

import { parseAuthConfigResponse } from '@rakomi/sdk-core';

import { normalizeNetworkError, sdkFetch } from '../lib/fetch-client.js';
import type { AuthConfig, AuthError } from '../types.js';

const UNSAFE_PROVIDER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type ConfigState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; config: AuthConfig }
  | { status: 'error'; error: AuthError };

type Subscriber = () => void;

export class AuthConfigManager {
  private readonly clientId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly cacheKey: string;
  private state: ConfigState = { status: 'idle' };
  private subscribers = new Set<Subscriber>();
  private fetchPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(clientId: string, baseUrl: string, apiKey: string) {
    this.clientId = clientId;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.cacheKey = `rakomi:config:v3:${clientId}:${encodeURIComponent(baseUrl)}`;
  }

  /** Public method to check if this manager matches given config */
  isSameConfig(clientId: string, baseUrl: string): boolean {
    return this.clientId === clientId && this.baseUrl === baseUrl;
  }

  private errorAt = 0;
  private static readonly ERROR_RETRY_MS = 30_000;

  /**
   * Fetch config (lazy — called by useAuthConfig hook, not on mount).
   * Returns cached data if available and fresh.
   */
  async fetch(): Promise<void> {
    if (this.state.status === 'loaded') return;

    if (this.state.status === 'error') {
      if (Date.now() - this.errorAt < AuthConfigManager.ERROR_RETRY_MS) return;
      this.state = { status: 'idle' };
    }

    if (this.fetchPromise) return this.fetchPromise;

    const cached = this.readCache();
    if (cached) {
      this.state = { status: 'loaded', config: cached };
      this.notify();
      return;
    }

    this.state = { status: 'loading' };
    this.notify();

    this.fetchPromise = this.doFetch();
    return this.fetchPromise;
  }

  private async doFetch(): Promise<void> {
    const gen = this.generation;

    try {
      const response = await sdkFetch(`${this.baseUrl}/v1/auth/config`, {
        method: 'GET',
        headers: { 'X-API-Key': this.apiKey },
      });

      if (gen !== this.generation) return;

      if (!response.ok) {
        this.errorAt = Date.now();
        this.state = { status: 'error', error: { code: 'NETWORK_ERROR' as const, message: `Config fetch failed: ${response.status}` } };
        this.notify();
        return;
      }

      let json: unknown;
      try { json = await response.json(); } catch {
        if (gen !== this.generation) return;
        this.errorAt = Date.now();
        this.state = { status: 'error', error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON from config endpoint' } };
        this.notify();
        return;
      }

      if (gen !== this.generation) return;

      const config: AuthConfig = parseAuthConfigResponse(json, this.baseUrl);

      this.writeCache(config);
      this.state = { status: 'loaded', config };
      this.notify();
    } catch (err) {
      if (gen !== this.generation) return;
      this.errorAt = Date.now();
      this.state = { status: 'error', error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
      this.notify();
    } finally {
      this.fetchPromise = null;
    }
  }

  /** Invalidate cache and re-fetch (e.g., on social 404). */
  invalidate(): void {
    this.removeCache();
    this.generation++;
    this.fetchPromise = null;
    this.state = { status: 'idle' };
    this.notify();
  }

  subscribe = (callback: Subscriber): (() => void) => {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  };

  getSnapshot = (): ConfigState => {
    if (!Object.isFrozen(this.state)) {
      if (this.state.status === 'loaded') {
        Object.freeze(this.state.config.methods);
        Object.freeze(this.state.config.socialProviders);
        if (this.state.config.branding) Object.freeze(this.state.config.branding);
        Object.freeze(this.state.config);
      } else if (this.state.status === 'error') {
        Object.freeze(this.state.error);
      }
      Object.freeze(this.state);
    }
    return this.state;
  };

  getServerSnapshot = (): ConfigState => {
    return { status: 'idle' };
  };

  private notify(): void {
    for (const sub of this.subscribers) sub();
  }

  private readCache(): AuthConfig | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.sessionStorage.getItem(this.cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (typeof parsed !== 'object' || parsed === null) return null;
      if (typeof parsed['expiresAt'] !== 'number') return null;
      if (Date.now() > parsed['expiresAt']) {
        window.sessionStorage.removeItem(this.cacheKey);
        return null;
      }

      const config = parsed['config'] as Record<string, unknown> | undefined;
      if (!config || typeof config !== 'object') return null;
      if (!Array.isArray(config['methods'])) return null;
      const cachedSocialProviders = config['socialProviders'];
      if (cachedSocialProviders === null || typeof cachedSocialProviders !== 'object' || Array.isArray(cachedSocialProviders)) return null;
      for (const [key, value] of Object.entries(cachedSocialProviders as Record<string, unknown>)) {
        if (UNSAFE_PROVIDER_KEYS.has(key)) return null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const flags = value as Record<string, unknown>;
        if (typeof flags['signIn'] !== 'boolean' || typeof flags['signUp'] !== 'boolean') return null;
      }
      if (typeof config['mfaEnforced'] !== 'boolean') return null;

      const cachedBranding = config['branding'] as Record<string, unknown> | undefined;
      if (cachedBranding && typeof cachedBranding === 'object') {
        const HEX_RE = /^#[0-9a-fA-F]{6}$/;
        for (const key of ['primaryColor', 'backgroundColor', 'buttonColor', 'textColor']) {
          const v = cachedBranding[key];
          if (v !== undefined && (typeof v !== 'string' || !HEX_RE.test(v))) return null;
        }
        const logoUrl = cachedBranding['logoUrl'];
        if (logoUrl !== undefined && typeof logoUrl === 'string') {
          try {
            if (new URL(logoUrl).origin !== new URL(this.baseUrl).origin) return null;
          } catch { return null; }
        }
        if (typeof cachedBranding['tenantName'] !== 'string') return null;
      }

      return config as unknown as AuthConfig;
    } catch {
      return null;
    }
  }

  private writeCache(config: AuthConfig): void {
    if (typeof window === 'undefined') return;
    try {
      const entry = { config, expiresAt: Date.now() + 300_000 };
      window.sessionStorage.setItem(this.cacheKey, JSON.stringify(entry));
    } catch {
    }
  }

  private removeCache(): void {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.removeItem(this.cacheKey);
    } catch {
    }
  }
}
