import type { CryptoKey as JoseCryptoKey } from 'jose';
import { importJWK } from 'jose';

import { JWKS_FETCH_FAILED, JWKS_INVALID_RESPONSE, JWKS_NO_MATCHING_KEY } from './errors.js';
import { resolveIssuerJwksUri } from './internal/issuer-jwks.js';
import { type AllowedSigningAlgorithm, isAcceptableSigningJwk } from './internal/signing-algorithms.js';
import type { SdkError } from './types.js';

interface JwkEntry {
  kid: string;
  key: JoseCryptoKey;
  alg: AllowedSigningAlgorithm;
}

/** A verification key together with the algorithm its key record is bound to. */
export interface ResolvedKey {
  key: JoseCryptoKey;
  alg: AllowedSigningAlgorithm;
}

/**
 * Where a {@link JwksCache} reads keys from: an explicit JWKS document URL, or an issuer whose
 * discovery document names its `jwks_uri`.
 */
export type JwksSource = { jwksUrl: string } | { issuer: string; discoveryOrigin?: string };

interface CacheState {
  jwksUrl: string;
  keys: JwkEntry[];
  revocationEpoch: number | null;
  fetchedAt: number;
  maxAge: number;
}

const DEFAULT_MAX_AGE = 3600;
/**
 * Minimum time between two refreshes triggered by an unknown `kid` while the cache is still fresh.
 * Without it every token carrying a new, never-seen `kid` forces a network fetch, so a stream of
 * forged tokens turns the verifier into a JWKS request amplifier. A genuinely rotated key is picked
 * up by the first unknown-kid lookup after the window (or on the next max-age expiry).
 */
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30_000;

type CacheResult<T> = { ok: true; data: T } | { ok: false; error: SdkError };

export class JwksCache {
  private cache: CacheState | null = null;
  private refreshPromise: Promise<CacheResult<void>> | null = null;
  private lastRefreshAttemptAt: number | null = null;
  private readonly source: JwksSource;

  constructor(source: JwksSource) {
    this.source = source;
  }

  /** A cache reading the JWKS document at exactly `jwksUrl` (a proxy or mirror is legitimate). */
  static fromJwksUrl(jwksUrl: string): JwksCache {
    return new JwksCache({ jwksUrl });
  }

  /**
   * A cache reading the keys of `issuer`: the `jwks_uri` is taken from the issuer's discovery
   * document on every refresh, so keys of any other issuer are never in this set. `discoveryOrigin`
   * fetches that document from another origin; its `issuer` must still match exactly.
   */
  static forIssuer(issuer: string, discoveryOrigin?: string): JwksCache {
    return new JwksCache(discoveryOrigin === undefined ? { issuer } : { issuer, discoveryOrigin });
  }

  /**
   * Get the revocation epoch from the last JWKS response.
   * Returns null if no revocation has occurred or JWKS hasn't been fetched yet.
   */
  getRevocationEpoch(): number | null {
    return this.cache?.revocationEpoch ?? null;
  }

  async getKey(kid: string): Promise<CacheResult<ResolvedKey>> {
    if (this.cache && !this.isExpired()) {
      const entry = this.cache.keys.find((k) => k.kid === kid);
      if (entry) {
        return { ok: true, data: { key: entry.key, alg: entry.alg } };
      }
      if (
        this.lastRefreshAttemptAt !== null &&
        Date.now() - this.lastRefreshAttemptAt < UNKNOWN_KID_REFRESH_COOLDOWN_MS
      ) {
        return { ok: false, error: JWKS_NO_MATCHING_KEY() };
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

    return { ok: true, data: { key: entry.key, alg: entry.alg } };
  }

  async refresh(): Promise<CacheResult<void>> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.lastRefreshAttemptAt = Date.now();
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

  private async resolveJwksUrl(): Promise<string> {
    if ('jwksUrl' in this.source) return this.source.jwksUrl;
    return resolveIssuerJwksUri(this.source.issuer, this.source.discoveryOrigin);
  }

  private async doRefresh(): Promise<CacheResult<void>> {
    let jwksUrl: string;
    try {
      jwksUrl = await this.resolveJwksUrl();
    } catch (err) {
      if (this.cache) {
        return { ok: true, data: undefined };
      }
      return { ok: false, error: JWKS_FETCH_FAILED(err instanceof Error ? err.message : 'Discovery failed') };
    }

    let response: Response;
    try {
      response = await fetch(jwksUrl, {
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
      if (!isAcceptableSigningJwk(jwk)) continue;
      const alg = jwk.alg as AllowedSigningAlgorithm;
      try {
        const key = await importJWK(jwk, alg);
        if (!(key instanceof Uint8Array)) {
          entries.push({ kid: jwk.kid as string, key, alg });
        }
      } catch {
      }
    }

    const maxAge = parseCacheControlMaxAge(response.headers.get('Cache-Control'));

    this.cache = {
      jwksUrl,
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
