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
 *
 * Trust model (RFC 8414 §3.3): a fetched discovery document is used only after its `issuer` field
 * is confirmed identical to the EXPECTED issuer for `baseUrl` — see
 * {@link discoveryIssuerMatchesBaseUrl} and {@link resolveExpectedIssuer}. A bound custom domain
 * genuinely mints a per-tenant `issuer` (a resolver-derived value); a platform-hosted deployment
 * (any rakomi.com-family or local-dev host) still mints the SAME frozen platform constant it
 * always did, regardless of which specific such host `baseUrl` names — so the expectation this
 * comparison checks against is `resolveExpectedIssuer(baseUrl)`, never `baseUrl` verbatim. Either
 * way this is a real trust anchor, not a tautology — the earlier host-naming-convention substitute
 * this module relied on before any of this was true is gone; see
 * {@link deriveAuthorizationEndpointFallback}'s own docstring for the one place a host-naming
 * convention is still used (the discovery-unreachable fallback, unaffected by this trust model).
 *
 * An untrusted discovery response (a missing/empty `issuer`, or one that does not match the
 * expected issuer) is NOT treated as "discovery unreachable" — it is a distinct failure class that
 * never falls through to the host-naming derivation. A server that answers but disclaims being the
 * expected issuer (or omits the REQUIRED §3.1 `issuer` field entirely) is a real
 * misconfiguration-or-attack signal, not a transport hiccup; swallowing it into the same
 * safe-but-silent fallback path used for "the network was down" would hide that signal from the
 * caller. See {@link UntrustedDiscoveryIssuerError} and `createAuthorizationEndpointCache`'s own
 * docstring.
 */

import type { AuthError } from '../types/auth-error.js';
import { resolveExpectedIssuer, stripTrailingSlash } from './issuer.js';

export interface AuthorizationEndpointDiscoveryDocument {
  issuer?: unknown;
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
 * The PATH is frozen at `/authorize` and is composed here directly — a plain
 * `new URL('/authorize', accountsBaseUrl)` — mirroring `@rakomi/node`'s identically-named
 * function for the same platform (both packages independently freeze the same path; a
 * value-mirror test keeps the two, and the platform's own frozen constant, in lock-step).
 * `accountsBaseUrl` is always this function's OWN internal construction (below) — a bare
 * `https://<host>[:port]` with no path/query/fragment already present to collide with — so no
 * separate fragment/double-slash/host-mismatch handling is needed here.
 *
 * This is a fallback for when discovery is UNREACHABLE — it is unrelated to, and unaffected by,
 * the discovery TRUST model ({@link discoveryIssuerMatchesBaseUrl}) below.
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
 * RFC 8414 §3.3 discovery-response validation: *"The 'issuer' value returned MUST be identical to
 * the authorization server's issuer identifier value into which the well-known URI string was
 * inserted to create the URL used to retrieve the metadata... If these values are not identical,
 * the data contained in the response MUST NOT be used."*
 *
 * The "issuer identifier value" this SDK compares against is NOT `baseUrl` verbatim — it is
 * {@link resolveExpectedIssuer}'s platform-host-aware resolution of it (see that function's own
 * docstring for why: the platform's `JWT_ISSUER` is frozen to the same constant across every
 * physical deployment, so a `baseUrl` pointed at any rakomi.com-family or local-dev host must
 * still expect that constant, never `baseUrl` itself). Only for a genuinely bound custom domain
 * does the expected value become `baseUrl` itself. Either way, the comparison against the
 * discovery document's actual `issuer` claim is STRICT string equality after normalizing away a
 * single trailing slash on each side — never a prefix/suffix/substring match, which would let
 * `https://acme.com.attacker.test` (or an issuer that is merely a path-prefix of the expectation,
 * e.g. claiming `/prod` while served from `/staging`) pass as legitimate.
 */
export function discoveryIssuerMatchesBaseUrl(issuer: string, baseUrl: string): boolean {
  return stripTrailingSlash(issuer) === resolveExpectedIssuer(baseUrl);
}

/**
 * Thrown for an RFC 8414 §3.3 issuer-trust failure — a missing/empty `issuer` (§3.1 marks it
 * REQUIRED, so its absence is itself non-conformance, not a benign gap) or one that does not
 * identify `baseUrl`. A DISTINCT class from every other extraction failure below (malformed/
 * missing `authorization_endpoint`, wrong scheme): `createAuthorizationEndpointCache` catches this
 * one specifically and fails closed — no host-naming fallback, no silent substitution — because,
 * unlike an unreachable server or an incomplete-but-authentic document, a server that answers but
 * disclaims being `baseUrl`'s issuer (or omits the field required to say so) is a real
 * misconfiguration-or-attack signal that must reach the caller, not a gap a safe guess can paper
 * over. A missing issuer is grouped with a mismatched one, not with "malformed document": treating
 * it as a mere shape gap would let an attacker bypass the mismatch check simply by omitting the
 * field instead of forging a wrong value.
 */
export class UntrustedDiscoveryIssuerError extends Error {}

function extractAuthorizationEndpoint(doc: unknown, baseUrl: string): string {
  const issuer = (doc as AuthorizationEndpointDiscoveryDocument | null)?.issuer;
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new UntrustedDiscoveryIssuerError(
      `discovery document for base URL "${baseUrl}" is missing a non-empty string \`issuer\` field ` +
        '(RFC 8414 §3.1 REQUIRED, §3.3 forbids using a response that cannot confirm it) — refusing ' +
        'to trust this discovery response',
    );
  }
  if (!discoveryIssuerMatchesBaseUrl(issuer, baseUrl)) {
    throw new UntrustedDiscoveryIssuerError(
      `discovery document issuer "${issuer}" does not match the expected issuer ` +
        `"${resolveExpectedIssuer(baseUrl)}" for base URL "${baseUrl}" ` +
        '(RFC 8414 §3.3: "the data contained in the response MUST NOT be used") — refusing to trust ' +
        'this discovery response',
    );
  }

  const endpoint = (doc as AuthorizationEndpointDiscoveryDocument | null)?.authorization_endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('discovery document is missing a non-empty string authorization_endpoint field');
  }
  const parsed = new URL(endpoint);
  const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error('authorization_endpoint must use https (except on localhost)');
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
 * back to {@link deriveAuthorizationEndpointFallback} when discovery is unreachable or its document
 * is incomplete/malformed, and surfacing an `INVALID_CONFIG` error when either (a) BOTH the live
 * fetch and the fallback fail, or (b) discovery answered but its `issuer` is missing or does not
 * match `baseUrl` — an {@link UntrustedDiscoveryIssuerError} — in which case the fallback is
 * deliberately NEVER attempted: that failure means the server does not confirm being `baseUrl`'s
 * issuer at all, so nothing it returned (including a plausible-looking `authorization_endpoint`)
 * is used, and substituting a guessed URL in its place would silently paper over a real
 * misconfiguration-or-attack signal instead of surfacing it. This never guesses and never
 * navigates a browser to a malformed, wrong-host, or unverified-issuer URL.
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
      if (discoveryErr instanceof UntrustedDiscoveryIssuerError) {
        result = {
          ok: false,
          error: { code: 'INVALID_CONFIG', message: discoveryErr.message },
        };
        return result;
      }
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
