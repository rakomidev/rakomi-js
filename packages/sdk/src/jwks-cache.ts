import type { CryptoKey as JoseCryptoKey } from 'jose';
import { importJWK } from 'jose';

import { JWKS_FETCH_FAILED, JWKS_INVALID_RESPONSE, JWKS_NO_MATCHING_KEY } from './errors.js';
import type { SdkError } from './types.js';

interface JwkEntry {
  kid: string;
  key: JoseCryptoKey;
}

interface CacheState {
  keys: JwkEntry[];
  revocationEpoch: number | null;
  fetchedAt: number;
  maxAge: number;
}

const DEFAULT_MAX_AGE = 3600;

type CacheResult<T> = { ok: true; data: T } | { ok: false; error: SdkError };

export class JwksCache {
  private cache: CacheState | null = null;
  private refreshPromise: Promise<CacheResult<void>> | null = null;
  private readonly jwksUrl: string;
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.jwksUrl = `${this.baseUrl}/.well-known/jwks.json`;
  }

  /**
   * Get the base URL of this Rakomi deployment.
   * Used to derive the expected JWT audience claim value.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get the revocation epoch from the last JWKS response.
   * Returns null if no revocation has occurred or JWKS hasn't been fetched yet.
   */
  getRevocationEpoch(): number | null {
    return this.cache?.revocationEpoch ?? null;
  }

  async getKey(kid: string): Promise<CacheResult<JoseCryptoKey>> {
    if (this.cache && !this.isExpired()) {
      const entry = this.cache.keys.find((k) => k.kid === kid);
      if (entry) {
        return { ok: true, data: entry.key };
      }
    }

    const refreshResult = await this.refresh();
    if (!refreshResult.ok) {
      return refreshResult;
    }

    const entry = this.cache?.keys.find((k) => k.kid === kid);
    if (!entry) {
      return { ok: false, error: JWKS_NO_MATCHING_KEY() };
    }

    return { ok: true, data: entry.key };
  }

  async refresh(): Promise<CacheResult<void>> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private isExpired(): boolean {
    if (!this.cache) return true;
    const elapsed = (Date.now() - this.cache.fetchedAt) / 1000;
    return elapsed >= this.cache.maxAge;
  }

  private async doRefresh(): Promise<CacheResult<void>> {
    let response: Response;
    try {
      response = await fetch(this.jwksUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      if (this.cache) {
        return { ok: true, data: undefined };
      }
      const detail = err instanceof Error
        ? (err.name === 'TimeoutError' ? 'Request timeout' : err.message)
        : 'Network error';
      return { ok: false, error: JWKS_FETCH_FAILED(detail) };
    }

    if (!response.ok) {
      if (this.cache) {
        return { ok: true, data: undefined };
      }
      return { ok: false, error: JWKS_FETCH_FAILED(`HTTP ${response.status}`) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: JWKS_INVALID_RESPONSE() };
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !('keys' in body) ||
      !Array.isArray((body as Record<string, unknown>).keys)
    ) {
      return { ok: false, error: JWKS_INVALID_RESPONSE() };
    }

    const bodyObj = body as { keys: Array<Record<string, unknown>>; revocation_epoch?: unknown };
    const jwks = bodyObj.keys;

    let revocationEpoch: number | null = null;
    if (typeof bodyObj.revocation_epoch === 'number' && Number.isInteger(bodyObj.revocation_epoch) && bodyObj.revocation_epoch > 0) {
      revocationEpoch = bodyObj.revocation_epoch;
    }

    const entries: JwkEntry[] = [];
    for (const jwk of jwks) {
      if (jwk.alg === 'RS256' && jwk.use === 'sig' && typeof jwk.kid === 'string') {
        try {
          const key = await importJWK(jwk, 'RS256');
          if (!(key instanceof Uint8Array)) {
            entries.push({ kid: jwk.kid, key });
          }
        } catch {
        }
      }
    }

    const maxAge = parseCacheControlMaxAge(response.headers.get('Cache-Control'));

    this.cache = {
      keys: entries,
      revocationEpoch,
      fetchedAt: Date.now(),
      maxAge,
    };

    return { ok: true, data: undefined };
  }
}

function parseCacheControlMaxAge(header: string | null): number {
  if (!header) return DEFAULT_MAX_AGE;
  const match = header.match(/max-age=(\d+)/);
  if (!match?.[1]) return DEFAULT_MAX_AGE;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_AGE;
}
