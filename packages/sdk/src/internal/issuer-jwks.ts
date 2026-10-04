
import { stripTrailingSlash } from './issuer.js';

/**
 * Discovery document URLs to try for `issuer`, in order: OAuth 2.0 Authorization Server Metadata
 * (RFC 8414 §3.1, well-known segment inserted before the issuer path), then OpenID Connect
 * Discovery 1.0 §4 (well-known segment appended to the issuer). `discoveryOrigin` fetches the same
 * paths from another origin; the document's `issuer` must still equal `issuer` exactly.
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

/** A discovery document that exists but belongs to another issuer. Never retried. */
export class IssuerMismatchError extends Error {}

function isHttpsOrLocalhost(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** Read `jwks_uri` from a discovery document; its `issuer` must equal the expected one exactly. */
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

const DISCOVERY_TIMEOUT_MS = 5000;

/** Fetch one discovery document: parsed JSON, `null` on HTTP 404, throw on anything else. */
async function fetchDiscoveryDocument(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`discovery fetch failed: HTTP ${response.status}`);
  return response.json();
}

/**
 * Resolve the `jwks_uri` of `issuer` by trying each discovery form in turn. A missing document
 * moves on to the next form; a document naming another issuer stops immediately.
 */
export async function resolveIssuerJwksUri(
  issuer: string,
  discoveryOrigin?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let lastError: unknown = null;
  for (const url of issuerDiscoveryUrls(issuer, discoveryOrigin)) {
    let document: unknown;
    try {
      document = await fetchDiscoveryDocument(url, fetchImpl);
    } catch (err) {
      lastError = err;
      continue;
    }
    if (document === null) continue;
    return extractJwksUri(document, issuer);
  }
  throw lastError instanceof Error ? lastError : new Error(`no discovery document found for issuer "${issuer}"`);
}
