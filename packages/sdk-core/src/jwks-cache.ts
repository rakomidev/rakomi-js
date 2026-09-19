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
 *
 * RS256-only, at the key-import boundary — not only at the caller's `jwtVerify(...{algorithms})`
 * site. `security.md` ("NEVER read alg from token header", HS-family + `none` rejected) requires
 * the RS256 pin to be enforced independently of any single call site: `@rakomi/node`'s own
 * `JwksCache` already imports "only RS256 signing keys" (`packages/sdk/src/jwks-cache.ts`) before
 * ever handing a resolver to jose — this cache mirrors that defense-in-depth so a consumer that
 * forgets `algorithms: ['RS256']` on its own `jwtVerify` call still cannot select a non-RS256 key
 * out of the local JWKS set (there is none to select). A key missing `alg`/`use` is dropped, not
 * defaulted — an unlabelled key is not provably an RS256 signing key.
 */

import { createLocalJWKSet, type JSONWebKeySet, type JWK } from 'jose';

export interface JwksDocument {
  keys: JWK[];
}

/**
 * Narrow a fetched JWKS document to RS256 signing keys only (`alg === 'RS256' && use === 'sig'`),
 * mirroring `@rakomi/node`'s `JwksCache.doRefresh()` import filter. The ORIGINAL (unfiltered)
 * document is still what callers persist/see via `peek()`/`onFetched` — only the resolver handed
 * to `jose.jwtVerify` is built from the narrowed set, so a future re-narrow (a relaxed policy, or a
 * document that later gains an RS256 key) never loses information the caller already stored.
 */
function rs256SigningKeys(document: JwksDocument): JSONWebKeySet {
  return { keys: document.keys.filter((k) => k.alg === 'RS256' && k.use === 'sig') } as JSONWebKeySet;
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
      resolver: createLocalJWKSet(rs256SigningKeys(options.initial.document)),
    };
  }

  async function refresh(): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const document = await options.fetchJwks();
      const fetchedAt = now();
      const resolver = createLocalJWKSet(rs256SigningKeys(document));
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
