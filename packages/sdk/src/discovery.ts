/**
 * Resolve the `authorization_endpoint` a browser-navigation sign-in must target.
 *
 * The OAuth issuer's routing host (`baseUrl`, e.g. an API host) is not always the host that
 * renders the hosted login UI — RFC 8414's discovery document is the ONE binding announcement of
 * where that UI actually lives (`authorization_endpoint`), and it can differ from `baseUrl`.
 * Sending a top-level browser navigation (e.g. a server-side redirect built with
 * {@link buildAuthorizeUrl}) to the wrong host lands on a JSON API response instead of a login
 * form. This module fetches the discovery document once, caches the result, and falls back to a
 * deterministic host-naming convention only when live discovery is unreachable.
 */

import { OAUTH_AUTHORIZATION_ENDPOINT_UNRESOLVED } from './errors.js';
import type { SdkError, VerifyResult } from './types.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';

interface AuthorizationEndpointDiscoveryDocument {
  authorization_endpoint?: unknown;
}

/**
 * Deterministic host-naming fallback, used ONLY when live discovery is unreachable.
 *
 * The platform's login-UI host is named by swapping the leading `api` label of the issuer's
 * routing host for `accounts` (e.g. `api.rakomi.com` -> `accounts.rakomi.com`, an
 * environment-prefixed `api-<env>.rakomi.com` -> `accounts-<env>.rakomi.com`). This never invents
 * a mapping — a host whose leading label is not `api` has no documented convention to fall back
 * to, and is refused rather than guessed.
 */
/**
 * The single matcher for the "api." <-> "accounts." host-naming convention — shared by the
 * fallback derivation (below) AND the discovery-side trust check (see
 * {@link authorizationEndpointHostIsTrusted}), so the two can never independently drift.
 * Returns `null` when `hostname`'s leading label is not `api` — no convention to derive from.
 */
function deriveAccountsHostname(hostname: string): string | null {
  if (!/^api([.-]|$)/.test(hostname)) return null;
  return hostname.replace(/^api/, 'accounts');
}

export function deriveAuthorizationEndpointFallback(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`deriveAuthorizationEndpointFallback: "${baseUrl}" is not a valid absolute URL`);
  }
  const accountsHostname = deriveAccountsHostname(parsed.hostname);
  if (accountsHostname === null) {
    throw new Error(
      `deriveAuthorizationEndpointFallback: host "${parsed.hostname}" does not follow the ` +
        '"api." <-> "accounts." host-naming convention this fallback relies on — pass an explicit ' +
        '`authorizationEndpoint` override instead.',
    );
  }
  const accountsBaseUrl = `https://${accountsHostname}${parsed.port ? `:${parsed.port}` : ''}`;
  return new URL('/authorize', accountsBaseUrl).toString();
}

/**
 * Defence-in-depth against a compromised or misconfigured discovery response. RFC 8414 §3.3
 * requires a discovery document's `issuer` field to be checked against the issuer identifier
 * used to build the well-known request URL — but on this platform `issuer` is not guaranteed to
 * vary per deployment host, so a literal `issuer === baseUrl` check is not a safe substitute
 * here. The host-naming convention below is the invariant actually guaranteed per environment.
 *
 * When `baseUrl`'s host follows the "api." <-> "accounts." convention, the discovery-returned
 * `authorization_endpoint` MUST resolve to the SAME accounts host the deterministic fallback
 * would have produced — an arbitrary attacker-or-misconfiguration-controlled host is refused
 * (falls through to the fallback / a typed error) rather than silently navigated to. When
 * `baseUrl` has no established convention (a custom/enterprise domain), there is no expectation
 * to check against and discovery is trusted as-is, same as before this hardening.
 */
export function authorizationEndpointHostIsTrusted(authorizationEndpoint: string, baseUrl: string): boolean {
  const expectedAccountsHostname = deriveAccountsHostname(new URL(baseUrl).hostname);
  if (expectedAccountsHostname === null) return true;
  return new URL(authorizationEndpoint).hostname === expectedAccountsHostname;
}

function extractAuthorizationEndpoint(doc: unknown, baseUrl: string): string {
  const endpoint = (doc as AuthorizationEndpointDiscoveryDocument | null)?.authorization_endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('discovery document is missing a non-empty string authorization_endpoint field');
  }
  const parsed = new URL(endpoint);
  const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error('authorization_endpoint must use https (except on localhost)');
  }
  if (!isLocalhost && !authorizationEndpointHostIsTrusted(endpoint, baseUrl)) {
    throw new Error(
      `authorization_endpoint host "${parsed.hostname}" is untrusted for base URL "${baseUrl}" — refusing ` +
        'to navigate a browser to an unexpected host (does not match the "api." <-> "accounts." convention)',
    );
  }
  return endpoint;
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<VerifyResult<string>>>();

export interface ResolveAuthorizationEndpointOptions {
  /** Cache TTL in ms for a successfully resolved endpoint. Default 1h, clamped to <=24h. */
  ttlMs?: number;
  /** Time source — injected for tests. Default `Date.now`. */
  now?: () => number;
  /** Fetch implementation — injected for tests. Default the global `fetch`. */
  fetchImpl?: typeof fetch;
}

async function resolveFresh(
  baseUrl: string,
  options: ResolveAuthorizationEndpointOptions,
): Promise<VerifyResult<string>> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;

  let result: VerifyResult<string>;
  try {
    const res = await fetchImpl(`${baseUrl}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`discovery fetch failed: HTTP ${res.status}`);
    }
    const doc: unknown = await res.json();
    result = { ok: true, data: extractAuthorizationEndpoint(doc, baseUrl) };
  } catch (discoveryErr) {
    try {
      result = { ok: true, data: deriveAuthorizationEndpointFallback(baseUrl) };
    } catch (fallbackErr) {
      const discoveryMessage = discoveryErr instanceof Error ? discoveryErr.message : String(discoveryErr);
      const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      const error: SdkError = OAUTH_AUTHORIZATION_ENDPOINT_UNRESOLVED(
        `for "${baseUrl}": live discovery failed (${discoveryMessage}) and the host-naming fallback ` +
          `also failed (${fallbackMessage})`,
      );
      result = { ok: false, error };
    }
  }
  if (result.ok) cache.set(baseUrl, { value: result.data, fetchedAt: now() });
  return result;
}

/**
 * Resolve the real `authorization_endpoint` for `baseUrl` — via cached live OIDC discovery, with
 * a deterministic host-naming fallback when discovery is unreachable. Never throws — returns
 * {@link VerifyResult}. Pass the resolved value as {@link AuthorizeUrlOptions.authorizationEndpoint}
 * to {@link buildAuthorizeUrl} before navigating a browser.
 */
export async function resolveAuthorizationEndpoint(
  baseUrl: string = DEFAULT_BASE_URL,
  options: ResolveAuthorizationEndpointOptions = {},
): Promise<VerifyResult<string>> {
  const now = options.now ?? Date.now;
  const ttl = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);

  const hit = cache.get(baseUrl);
  if (hit && now() - hit.fetchedAt < ttl) return { ok: true, data: hit.value };

  const existing = inFlight.get(baseUrl);
  if (existing) return existing;

  const promise = resolveFresh(baseUrl, options).finally(() => inFlight.delete(baseUrl));
  inFlight.set(baseUrl, promise);
  return promise;
}

/** Drop the cached authorization_endpoint for `baseUrl`, or every cached value when omitted. Test helper. */
export function invalidateAuthorizationEndpointCache(baseUrl?: string): void {
  if (baseUrl) {
    cache.delete(baseUrl);
    inFlight.delete(baseUrl);
  } else {
    cache.clear();
    inFlight.clear();
  }
}
