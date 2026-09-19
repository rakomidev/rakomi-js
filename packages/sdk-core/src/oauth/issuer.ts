/**
 * Platform-host-aware issuer-expectation resolver.
 *
 * The platform's issuer-signing configuration is validated equal to the frozen
 * `RAKOMI_PLATFORM_ISSUER` constant in EVERY physical deployment — dev, staging and prod alike.
 * Only a tenant's own BOUND custom domain ever mints a token whose `iss` differs from that
 * constant: the resolved issuer is the tenant's bound custom-domain host when one exists, else the
 * frozen platform literal — for BOTH custom-domain and platform-hosted tenants alike, never a
 * special-cased branch.
 *
 * A consuming SDK only knows the `baseUrl` it was configured with, never which physical
 * deployment served it — so `baseUrl` alone is NOT a reliable proxy for "this tenant has bound a
 * custom domain". A client pointed at ANY rakomi.com-family host (a preview deployment, a
 * non-default physical environment, ...) or a local dev host must still expect the SAME frozen
 * `RAKOMI_PLATFORM_ISSUER` every such deployment actually mints — deriving the expectation from
 * `baseUrl` verbatim for these hosts would reject every real token a non-production rakomi.com
 * deployment issues. {@link resolveExpectedIssuer} is therefore two-tier: a platform-family host
 * resolves to the frozen constant; anything else (by construction, a genuinely bound custom
 * domain — never itself a rakomi.com subdomain) resolves to `baseUrl` itself.
 */

import { RAKOMI_PLATFORM_ISSUER } from '../_inlined-symbols.js';

/**
 * Normalizes a single trailing slash away so `https://host/env` and `https://host/env/` compare
 * equal — the ONE leniency this comparison allows, never a prefix/suffix match.
 */
export function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * `true` for `rakomi.com` itself, any of its subdomains (DNS-label-boundary match via a leading
 * `.` — never a bare `.includes()`/`.endsWith('rakomi.com')`, which `evilrakomi.com` would also
 * satisfy), or a local dev host (`localhost` / `127.0.0.1` / `::1`). A confusable host that is
 * NOT a genuine rakomi.com subdomain — `evilrakomi.com`, `rakomi.com.attacker.test` — returns
 * `false`, exactly as a real bound custom domain would: this function's job is only to recognise
 * hosts the platform itself owns, never to guess at attacker intent.
 */
function isPlatformHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]') return true;
  if (lower === 'rakomi.com') return true;
  return lower.endsWith('.rakomi.com');
}

/**
 * Resolve the expected `iss` — and, for discovery, the trust anchor a fetched document's own
 * `issuer` field must match — for `baseUrl`. Returns the frozen {@link RAKOMI_PLATFORM_ISSUER}
 * constant for a platform-family or local-dev host; otherwise returns `baseUrl` itself
 * (trailing-slash-stripped) — a genuinely bound custom domain, trusted as its own issuer identity.
 *
 * Never throws: a `baseUrl` that fails to parse as an absolute URL is returned back,
 * trailing-slash-stripped, unchanged — callers that want a DIFFERENT malformed-input fallback
 * (e.g. a hardcoded default) validate `baseUrl` themselves before calling this.
 */
export function resolveExpectedIssuer(baseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return stripTrailingSlash(baseUrl);
  }
  return isPlatformHost(hostname) ? RAKOMI_PLATFORM_ISSUER : stripTrailingSlash(baseUrl);
}
