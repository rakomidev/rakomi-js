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
 * - `withKeyRotationRetry` runs a verification against the key set and, when it fails only because
 *   the token's `kid` is not in the cached set (a key rotated since the last fetch), refreshes once and
 *   retries. A refresh started this way happens at most once per cooldown window, so a stream of tokens
 *   carrying never-seen `kid`s cannot turn the verifier into a JWKS request amplifier. Same algorithm as
 *   `@rakomi/node`'s `JwksCache.getKey`: a fresh cache with an unknown `kid` refreshes only if no
 *   refresh was attempted within the last 30 s; otherwise it fails with the original "no matching key".
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

/**
 * Minimum time between two refreshes when the only failure is an unknown `kid`. Matches
 * `@rakomi/node`'s `UNKNOWN_KID_REFRESH_COOLDOWN_MS`. A rotated key is picked up by the first
 * unknown-`kid` verification after the window, or at the next TTL expiry.
 */
export const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30_000;

/** jose's "no key in the set matches the token's protected header" error. */
function isNoMatchingKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ERR_JWKS_NO_MATCHING_KEY';
}

const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface JwksCache {
  /** Resolve a key resolver compatible with `jose.jwtVerify`. Refreshes if stale. */
  getKeySet(): Promise<ReturnType<typeof createLocalJWKSet>>;
  /** Last fetched document (or null if never fetched). */
  peek(): { document: JwksDocument; fetchedAt: number } | null;
  /** Force-refresh on next call. */
  invalidate(): void;
  /**
   * Run `verify` with the current key set. If it fails only because no cached key matches the token
   * (`ERR_JWKS_NO_MATCHING_KEY`, typically a key rotated since the last fetch), refresh once and retry,
   * unless a refresh was already attempted within the unknown-`kid` cooldown. Any other error, a
   * failed refresh, or a second "no matching key" is returned to the caller as-is.
   */
  withKeyRotationRetry<T>(verify: (keySet: ReturnType<typeof createLocalJWKSet>) => Promise<T>): Promise<T>;
}

export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const ttl = Math.min(options.ttlMs ?? 24 * 60 * 60 * 1000, MAX_TTL_MS);
  const now = options.now ?? Date.now;

  let cached: { document: JwksDocument; fetchedAt: number; resolver: ReturnType<typeof createLocalJWKSet> } | null = null;
  let inFlight: Promise<ReturnType<typeof createLocalJWKSet>> | null = null;
  let lastRefreshAttemptAt: number | null = null;

  if (options.initial) {
    cached = {
      document: options.initial.document,
      fetchedAt: options.initial.fetchedAt,
      resolver: createLocalJWKSet(rs256SigningKeys(options.initial.document)),
    };
  }

  async function refresh(): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (inFlight) return inFlight;
    lastRefreshAttemptAt = now();
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

  async function getKeySet(): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (cached && now() - cached.fetchedAt < ttl) return cached.resolver;
    try {
      return await refresh();
    } catch (err) {
      if (cached) return cached.resolver;
      throw err;
    }
  }

  return {
    getKeySet,
    async withKeyRotationRetry(verify) {
      const keySet = await getKeySet();
      try {
        return await verify(keySet);
      } catch (err) {
        if (!isNoMatchingKey(err)) throw err;
        if (lastRefreshAttemptAt !== null && now() - lastRefreshAttemptAt < UNKNOWN_KID_REFRESH_COOLDOWN_MS) throw err;
        let fresh: ReturnType<typeof createLocalJWKSet>;
        try {
          fresh = await refresh();
        } catch {
          throw err;
        }
        return verify(fresh);
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
