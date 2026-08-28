/**
 * Resolve the `authorization_endpoint` a browser-navigation sign-in must target.
 *
 * The OAuth issuer's routing host (`baseUrl`, e.g. an API host) is not always the host that
 * renders the hosted login UI — RFC 8414's discovery document is the ONE binding announcement
 * of where that UI actually lives (`authorization_endpoint`), and it can differ from `baseUrl`.
 * Sending a top-level browser navigation to the wrong host lands on a JSON API response instead
 * of a login form. This module fetches the discovery document once (caller-injected fetcher —
 * `sdk-core` performs no I/O of its own), caches the result, and falls back to a deterministic
 * host-naming convention (see {@link deriveAuthorizationEndpointFallback}) only when live
 * discovery is unreachable.
 */

import { buildAuthorizationEndpoint } from '../_inlined-symbols.js';

import type { AuthError } from '../types/auth-error.js';

export interface AuthorizationEndpointDiscoveryDocument {
  authorization_endpoint?: unknown;
}

export type ResolveAuthorizationEndpointResult =
  | { ok: true; authorizationEndpoint: string; source: 'discovery' | 'fallback' }
  | { ok: false; error: AuthError };

/**
 * Deterministic host-naming fallback, used ONLY when live discovery is unreachable.
 *
 * The platform's login-UI host is named by swapping the leading `api` label of the issuer's
 * routing host for `accounts` (e.g. `api.example.com` -> `accounts.example.com`, an
 * environment-prefixed `api-<env>.example.com` -> `accounts-<env>.example.com`). This never
 * invents a mapping — a host whose leading label is not `api` has no documented convention to
 * fall back to, and is refused rather than guessed.
 *
 * Reuses the platform's own hardened endpoint-rehosting logic (fragment/scheme/double-slash/
 * host-mismatch guards) rather than re-deriving the URL by hand.
 */
/**
 * The single matcher for the "api." <-> "accounts." host-naming convention — shared by the
 * fallback derivation (below) AND the discovery-side trust check (see
 * {@link authorizationEndpointHostIsTrusted}), so the two can never independently drift
 * (adversarial-review-blindness-checklist row 8: one matcher, not a re-declared copy).
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
  return buildAuthorizationEndpoint(accountsBaseUrl);
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

export interface AuthorizationEndpointCacheOptions {
  /** Fetch the discovery document JSON for a given base URL. `sdk-core` does no I/O itself. */
  fetchDiscoveryDocument: (baseUrl: string) => Promise<unknown>;
  /** Cache TTL in ms for a successfully resolved endpoint. Default 1h, clamped to <=24h. */
  ttlMs?: number;
  /** Time source — injected for tests. Default `Date.now`. */
  now?: () => number;
}

export interface AuthorizationEndpointCache {
  /** Resolve the authorization endpoint for `baseUrl`. Never throws. */
  resolve(baseUrl: string): Promise<ResolveAuthorizationEndpointResult>;
  /** Drop the cached value for `baseUrl`, or every cached value when omitted. */
  invalidate(baseUrl?: string): void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Create a per-baseUrl cache that resolves `authorization_endpoint` from live discovery, falling
 * back to {@link deriveAuthorizationEndpointFallback} when discovery fails, and surfacing an
 * `INVALID_CONFIG` error only when BOTH paths fail (never guesses, never navigates a browser to a
 * malformed or wrong-host URL).
 */
export function createAuthorizationEndpointCache(
  options: AuthorizationEndpointCacheOptions,
): AuthorizationEndpointCache {
  const ttl = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const now = options.now ?? Date.now;
  const cached = new Map<string, { value: ResolveAuthorizationEndpointResult; fetchedAt: number }>();
  const inFlight = new Map<string, Promise<ResolveAuthorizationEndpointResult>>();

  async function resolveFresh(baseUrl: string): Promise<ResolveAuthorizationEndpointResult> {
    let result: ResolveAuthorizationEndpointResult;
    try {
      const doc = await options.fetchDiscoveryDocument(baseUrl);
      const authorizationEndpoint = extractAuthorizationEndpoint(doc, baseUrl);
      result = { ok: true, authorizationEndpoint, source: 'discovery' };
    } catch (discoveryErr) {
      try {
        const authorizationEndpoint = deriveAuthorizationEndpointFallback(baseUrl);
        result = { ok: true, authorizationEndpoint, source: 'fallback' };
      } catch (fallbackErr) {
        const discoveryMessage = discoveryErr instanceof Error ? discoveryErr.message : String(discoveryErr);
        const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        result = {
          ok: false,
          error: {
            code: 'INVALID_CONFIG',
            message:
              `Could not resolve the OAuth authorization_endpoint for "${baseUrl}": live discovery ` +
              `failed (${discoveryMessage}) and the host-naming fallback also failed (${fallbackMessage}). ` +
              'Pass an explicit authorizationEndpoint override.',
          },
        };
      }
    }
    if (result.ok) cached.set(baseUrl, { value: result, fetchedAt: now() });
    return result;
  }

  return {
    resolve(baseUrl: string): Promise<ResolveAuthorizationEndpointResult> {
      const hit = cached.get(baseUrl);
      if (hit && now() - hit.fetchedAt < ttl) return Promise.resolve(hit.value);
      const existing = inFlight.get(baseUrl);
      if (existing) return existing;
      const promise = resolveFresh(baseUrl).finally(() => inFlight.delete(baseUrl));
      inFlight.set(baseUrl, promise);
      return promise;
    },
    invalidate(baseUrl?: string): void {
      if (baseUrl) {
        cached.delete(baseUrl);
        inFlight.delete(baseUrl);
      } else {
        cached.clear();
        inFlight.clear();
      }
    },
  };
}
