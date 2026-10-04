import { stripTrailingSlash } from './issuer.js';

/**
 * Each issuer publishes its own signing keys at the `jwks_uri` named in its discovery document.
 * A verifier therefore resolves keys from the issuer it expects — never from a fixed JWKS path —
 * so a key belonging to a different issuer is never in the set a token is checked against.
 */

/**
 * The discovery document URLs to try for `issuer`, in order.
 *
 * 1. OAuth 2.0 Authorization Server Metadata (RFC 8414 §3.1): the well-known segment is inserted
 *    between the host and the issuer's path — `https://host/.well-known/oauth-authorization-server/t/abc/test`
 *    for the issuer `https://host/t/abc/test`.
 * 2. OpenID Connect Discovery 1.0 §4: the well-known segment is appended to the issuer —
 *    `https://host/t/abc/test/.well-known/openid-configuration`.
 *
 * For an issuer without a path both forms sit at the host root. `discoveryOrigin` fetches the same
 * paths from another origin (the deployment the client is configured for) — the document's own
 * `issuer` must still equal `issuer` exactly.
 */
export function issuerDiscoveryUrls(issuer: string, discoveryOrigin?: string): string[] {
  const parsed = new URL(stripTrailingSlash(issuer));
  const origin = discoveryOrigin === undefined ? parsed.origin : new URL(discoveryOrigin).origin;
  const path = parsed.pathname === '/' ? '' : stripTrailingSlash(parsed.pathname);
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Thrown when a discovery document does not belong to the expected issuer. Never retried. */
export class IssuerMismatchError extends Error {}

function isHttpsOrLocalhost(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * Read `jwks_uri` from a discovery document fetched for `issuer`.
 *
 * The document's own `issuer` must equal the expected issuer exactly (a single trailing slash is
 * the only leniency); otherwise nothing in it is used (RFC 8414 §3.3). `jwks_uri` must be an
 * absolute https URL (plain http only on localhost).
 */
export function extractJwksUri(document: unknown, issuer: string): string {
  const doc = (document ?? {}) as { issuer?: unknown; jwks_uri?: unknown };
  if (typeof doc.issuer !== 'string' || stripTrailingSlash(doc.issuer) !== stripTrailingSlash(issuer)) {
    throw new IssuerMismatchError(
      `discovery document issuer ${JSON.stringify(doc.issuer)} does not equal the expected issuer "${issuer}"`,
    );
  }
  if (typeof doc.jwks_uri !== 'string' || doc.jwks_uri.length === 0) {
    throw new Error(`discovery document for "${issuer}" has no jwks_uri`);
  }
  const parsed = new URL(doc.jwks_uri);
  if (!isHttpsOrLocalhost(parsed)) {
    throw new Error(`jwks_uri for "${issuer}" must use https`);
  }
  return doc.jwks_uri;
}

/** Options for {@link createIssuerJwksUriResolver}. */
export interface IssuerJwksUriResolverOptions {
  /**
   * Fetch a discovery document. Resolve with the parsed JSON body, or with `null` when the
   * document does not exist at that URL (HTTP 404) so the next discovery form is tried.
   * Reject on any other failure.
   */
  fetchDiscoveryDocument: (url: string) => Promise<unknown>;
  /** How long a resolved `jwks_uri` is reused. Default 1 hour, at most 24 hours. */
  ttlMs?: number;
  /** Time source, for tests. Default `Date.now`. */
  now?: () => number;
}

/** Resolves and caches the `jwks_uri` of each issuer. */
export interface IssuerJwksUriResolver {
  /**
   * The `jwks_uri` published by `issuer`. Rejects if neither discovery form yields a trusted one.
   * `discoveryOrigin` is where the discovery document is fetched from (default: the issuer's origin).
   */
  resolve(issuer: string, discoveryOrigin?: string): Promise<string>;
  /** Forget the cached `jwks_uri` of `issuer`, or of every issuer. */
  invalidate(issuer?: string): void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Create a resolver that maps an issuer to the `jwks_uri` its discovery document names. */
export function createIssuerJwksUriResolver(options: IssuerJwksUriResolverOptions): IssuerJwksUriResolver {
  const ttl = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const now = options.now ?? Date.now;
  const cached = new Map<string, { jwksUri: string; fetchedAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  async function resolveFresh(issuer: string, discoveryOrigin: string | undefined): Promise<string> {
    let lastError: unknown = null;
    for (const url of issuerDiscoveryUrls(issuer, discoveryOrigin)) {
      let document: unknown;
      try {
        document = await options.fetchDiscoveryDocument(url);
      } catch (err) {
        lastError = err;
        continue;
      }
      if (document === null) continue;
      const jwksUri = extractJwksUri(document, issuer);
      cached.set(cacheKey(issuer, discoveryOrigin), { jwksUri, fetchedAt: now() });
      return jwksUri;
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`no discovery document found for issuer "${issuer}"`);
  }

  function cacheKey(issuer: string, discoveryOrigin: string | undefined): string {
    return `${stripTrailingSlash(issuer)} ${discoveryOrigin === undefined ? '' : new URL(discoveryOrigin).origin}`;
  }

  return {
    async resolve(issuer: string, discoveryOrigin?: string): Promise<string> {
      const key = cacheKey(issuer, discoveryOrigin);
      const hit = cached.get(key);
      if (hit && now() - hit.fetchedAt < ttl) return hit.jwksUri;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const promise = resolveFresh(stripTrailingSlash(issuer), discoveryOrigin).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
    invalidate(issuer?: string): void {
      if (issuer === undefined) {
        cached.clear();
        return;
      }
      const prefix = `${stripTrailingSlash(issuer)} `;
      for (const key of [...cached.keys()]) if (key.startsWith(prefix)) cached.delete(key);
    },
  };
}
