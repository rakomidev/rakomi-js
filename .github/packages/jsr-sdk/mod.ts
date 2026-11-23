/**
 * OpenID Connect discovery for a Rakomi issuer.
 *
 * @module
 */

/** Rejected or failed discovery. */
export class RakomiDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RakomiDiscoveryError";
  }
}

/** A JSON Web Key Set. */
export interface JsonWebKeySet {
  /** The keys. */
  keys: Record<string, unknown>[];
  [member: string]: unknown;
}

/** The provider metadata of an issuer and the key set its `jwks_uri` serves. */
export interface RakomiDiscovery {
  /** The issuer, exactly as the metadata names it. */
  issuer: string;
  /** The OpenID provider metadata. */
  metadata: Record<string, unknown>;
  /** The JSON Web Key Set. */
  jwks: JsonWebKeySet;
}

/** Options of {@link discover}. */
export interface DiscoverOptions {
  /** The fetch implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
  /** Time limit per request in milliseconds (default 10000). */
  timeoutMs?: number;
}

/**
 * Fetches the OpenID provider metadata of `issuer` and the JSON Web Key Set
 * its `jwks_uri` names. HTTPS only, no redirects; the metadata `issuer` must
 * equal `issuer` exactly (OpenID Connect Discovery 1.0 §4.3).
 *
 * @example
 * ```ts
 * const d = await discover("https://auth.example.com");
 * d.jwks.keys;
 * ```
 */
export async function discover(
  issuer: string | URL,
  options: DiscoverOptions = {},
): Promise<RakomiDiscovery> {
  const issuerText = typeof issuer === "string" ? issuer : issuer.href;
  requireHttps(issuerText, "issuer");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = issuerText.endsWith("/") ? issuerText.slice(0, -1) : issuerText;
  const metadata = await getJsonObject(
    doFetch,
    `${base}/.well-known/openid-configuration`,
    timeoutMs,
  );
  if (metadata.issuer !== issuerText) {
    throw new RakomiDiscoveryError("the metadata names another issuer");
  }
  const jwksUri = metadata.jwks_uri;
  if (typeof jwksUri !== "string") {
    throw new RakomiDiscoveryError("the metadata has no jwks_uri");
  }
  requireHttps(jwksUri, "jwks_uri");
  const jwks = await getJsonObject(doFetch, jwksUri, timeoutMs);
  if (!Array.isArray(jwks.keys)) {
    throw new RakomiDiscoveryError("the key set has no keys array");
  }
  return { issuer: issuerText, metadata, jwks: jwks as JsonWebKeySet };
}

function requireHttps(value: string, what: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new RakomiDiscoveryError(`${what} is not a URL`);
  }
  if (
    u.protocol !== "https:" || u.hostname === "" || u.search !== "" ||
    u.hash !== "" || value.includes("#") || value.includes("?") ||
    u.username !== "" || u.password !== ""
  ) {
    throw new RakomiDiscoveryError(
      `${what} must be an https URL without credentials, query or fragment`,
    );
  }
}

async function getJsonObject(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await doFetch(url, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RakomiDiscoveryError(`the request to ${host} failed`);
  }
  if (res.status !== 200) {
    throw new RakomiDiscoveryError(`${host} answered HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RakomiDiscoveryError(`${host} did not answer JSON`);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RakomiDiscoveryError(`${host} did not answer a JSON object`);
  }
  return body as Record<string, unknown>;
}
