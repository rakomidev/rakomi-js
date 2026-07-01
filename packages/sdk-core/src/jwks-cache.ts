/**
 * JWKS cache — fetch-once + TTL, backed by `jose.createLocalJWKSet` for offline verification.
 *
 * RN runtime needs a way to verify JWT signatures without a network
 * round-trip on every call. Web `@rakomi/react` does this via the platform's `crypto.subtle`
 * + `jose.createRemoteJWKSet`. RN doesn't always have a stable `crypto.subtle` (Hermes), but
 * jose's web-api build runs cleanly because we run RN with the @noble polyfill chain in the
 * Expo adapter.
 *
 * Design:
 * - Pure data layer: a `JwksCache` is created with a fetcher (the SDK injects one that uses
 * the `HttpClient` adapter so SSRF guards apply) and a TTL.
 * - Cache hit path is in-memory only — no storage. Persistence (across cold-starts,
 * "offline-stale" path) is handled by the runtime via `KeyValueStore` + `deriveTenantStorageKey`.
 * - `getKeySet` returns the localJWKSet function jose expects (`(protectedHeader, token) => Key`).
 */

import { createLocalJWKSet, type JSONWebKeySet, type JWK } from 'jose';

export interface JwksDocument {
  keys: JWK[];
}

export interface JwksCacheOptions {
  /** Time-to-live for cached JWKS in milliseconds. Default: 24h. Clamped to ≤7d. */
  ttlMs?: number;
  /** Fetcher returning a fresh JWKS document. */
  fetchJwks: () => Promise<JwksDocument>;
  /** Optional preload (e.g. from KeyValueStore on cold-start). */
  initial?: { document: JwksDocument; fetchedAt: number };
  /** Optional sink invoked on every fresh fetch (used by runtime to persist to KV). */
  onFetched?: (document: JwksDocument, fetchedAt: number) => void;
  /** Time source — injected for tests. Default: Date.now. */
  now?: () => number;
}

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface JwksCache {
  /** Resolve a key resolver compatible with `jose.jwtVerify`. Refreshes if stale. */
  getKeySet(): Promise<ReturnType<typeof createLocalJWKSet>>;
  /** Last fetched document (or null if never fetched). */
  peek(): { document: JwksDocument; fetchedAt: number } | null;
  /** Force-refresh on next call (used after sig-verify failure with `kid` not in cache). */
  invalidate(): void;
}

export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const ttl = Math.min(options.ttlMs ?? 24 * 60 * 60 * 1000, MAX_TTL_MS);
  const now = options.now ?? Date.now;

  let cached: { document: JwksDocument; fetchedAt: number; resolver: ReturnType<typeof createLocalJWKSet> } | null = null;
  let inFlight: Promise<ReturnType<typeof createLocalJWKSet>> | null = null;

  if (options.initial) {
    cached = {
      document: options.initial.document,
      fetchedAt: options.initial.fetchedAt,
      resolver: createLocalJWKSet(options.initial.document as JSONWebKeySet),
    };
  }

  async function refresh(): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const document = await options.fetchJwks();
      const fetchedAt = now();
      const resolver = createLocalJWKSet(document as JSONWebKeySet);
      cached = { document, fetchedAt, resolver };
      options.onFetched?.(document, fetchedAt);
      return resolver;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async getKeySet() {
      if (cached && now() - cached.fetchedAt < ttl) return cached.resolver;
      try {
        return await refresh();
      } catch (err) {
        if (cached) return cached.resolver;
        throw err;
      }
    },
    peek() {
      return cached ? { document: cached.document, fetchedAt: cached.fetchedAt } : null;
    },
    invalidate() {
      cached = null;
    },
  };
}
