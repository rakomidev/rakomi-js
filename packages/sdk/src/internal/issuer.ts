
const RAKOMI_PLATFORM_ISSUER = 'https://api.rakomi.com';

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
 * satisfy), or a local dev host (`localhost` / `127.0.0.1` / `[::1]` — WHATWG URL's `.hostname`
 * keeps the brackets on an IPv6 literal, checked bracketed, never bare). A confusable host that is
 * NOT a genuine rakomi.com subdomain — `evilrakomi.com`, `rakomi.com.attacker.test` — returns
 * `false`, exactly as a real bound custom domain would.
 */
export function isPlatformHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]') return true;
  if (lower === 'rakomi.com') return true;
  return lower.endsWith('.rakomi.com');
}

/**
 * Resolve the expected `iss` — and, for discovery, the trust anchor a fetched document's own
 * `issuer` field must match — for `baseUrl`. Returns the frozen `RAKOMI_PLATFORM_ISSUER` constant
 * for a platform-family or local-dev host; otherwise returns `baseUrl` itself (trailing-slash-
 * stripped) — a genuinely bound custom domain, trusted as its own issuer identity.
 *
 * Never throws: a `baseUrl` that fails to parse as an absolute URL is returned back,
 * trailing-slash-stripped, unchanged — callers that want a DIFFERENT malformed-input fallback
 * (e.g. a hardcoded default) validate `baseUrl` themselves before calling this.
 */
/**
 * Where to fetch `issuer`'s discovery document from. A platform-family issuer is served by whichever
 * deployment the client is configured for (`baseUrl`), because every platform deployment mints the
 * same platform-family issuer; any other issuer (a custom domain) is its own origin.
 */
export function discoveryOriginFor(issuer: string, baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  let issuerHost: string;
  try {
    issuerHost = new URL(issuer).hostname;
    new URL(baseUrl);
  } catch {
    return undefined;
  }
  return isPlatformHost(issuerHost) ? baseUrl : undefined;
}

export function resolveExpectedIssuer(baseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return stripTrailingSlash(baseUrl);
  }
  return isPlatformHost(hostname) ? RAKOMI_PLATFORM_ISSUER : stripTrailingSlash(baseUrl);
}
