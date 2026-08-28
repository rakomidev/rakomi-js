// SPDX-License-Identifier: MIT
// Copyright (c) CRE8EVE Sp. z o.o.

import {
  CONFIG_INVALID_CHALLENGE_PARAM,
  CONFIG_INVALID_OPTION,
  CONFIG_INVALID_RESOURCE,
  CONFIG_INVALID_URL,
  CONFIG_MISSING_PIN,
  RakomiError,
  TOKEN_MALFORMED,
} from './errors.js';
import { JwksCache } from './jwks-cache.js';
import type {
  ChallengeOptions,
  ProtectedResourceMetadata,
  ProtectedResourceMetadataOptions,
  TokenPayload,
  VerifyRakomiTokenOptions,
  VerifyResult,
} from './types.js';
import { verifyTokenWithOptions } from './verify-token.js';

const DEFAULT_ISSUER = 'https://api.rakomi.com';
const DEFAULT_JWKS_URL = 'https://api.rakomi.com/.well-known/jwks.json';
const PLATFORM_AUDIENCE = 'https://api.rakomi.com';
const DEFAULT_AUTHORIZATION_SERVERS = [DEFAULT_ISSUER] as const;

const DEFAULT_CLOCK_TOLERANCE = 30;
const MAX_CLOCK_TOLERANCE = 120;

const MAX_JWKS_MEMO_ENTRIES = 8;
const jwksMemo = new Map<string, JwksCache>();

function getMemoizedJwksCache(jwksUrl: string): JwksCache {
  const existing = jwksMemo.get(jwksUrl);
  if (existing) {
    jwksMemo.delete(jwksUrl);
    jwksMemo.set(jwksUrl, existing);
    return existing;
  }
  const created = JwksCache.fromJwksUrl(jwksUrl);
  if (jwksMemo.size >= MAX_JWKS_MEMO_ENTRIES) {
    const oldest = jwksMemo.keys().next().value;
    if (oldest !== undefined) {
      jwksMemo.delete(oldest);
    }
  }
  jwksMemo.set(jwksUrl, created);
  return created;
}

export function __resetJwksMemoForTesting(): void {
  jwksMemo.clear();
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:';
}

/**
 * Verify a Rakomi-issued access token on a third-party resource server —
 * standalone: no apiKey, no `RakomiClient`.
 *
 * Two verification modes, selected by the presence of `options.audience`:
 *
 * - **Mode A (`audience` provided)** — the token's `aud` must equal your
 *   resource identifier exactly (literal string equality, no URL
 *   normalization). For clients sending RFC 8707 resource-bound tokens.
 * - **Mode B (`audience` absent)** — the token must carry the Rakomi platform
 *   audience AND `requiredTenantId` is mandatory. Without a tenant pin, a
 *   platform-audience token issued to any application would verify here
 *   (cross-app replay) — that configuration returns a config error instead.
 *
 * NEVER throws — every failure (including a malformed JWKS response) is a
 * `{ ok: false, error }` result. Verification rules match
 * `RakomiClient.verifyToken()` (RS256-only, single-string `aud`, bounded
 * token age, revocation epoch from the JWKS document), plus an RFC 9068
 * `typ: at+jwt` access-token check on this path.
 */
export async function verifyRakomiToken<T extends TokenPayload = TokenPayload>(
  token: string,
  options: VerifyRakomiTokenOptions,
): Promise<VerifyResult<T>> {
  try {
    const opts: Partial<VerifyRakomiTokenAudienceShape> =
      options && typeof options === 'object' ? options : {};

    const issuer = opts.issuer ?? DEFAULT_ISSUER;
    const jwksUrl = opts.jwksUrl ?? DEFAULT_JWKS_URL;

    if (!isHttpsUrl(issuer)) {
      return { ok: false, error: CONFIG_INVALID_URL('issuer') };
    }
    if (!isHttpsUrl(jwksUrl)) {
      return { ok: false, error: CONFIG_INVALID_URL('jwksUrl') };
    }

    const audience = opts.audience ?? undefined;
    const requiredTenantId = opts.requiredTenantId ?? undefined;
    const requiredClientId = opts.requiredClientId ?? undefined;
    const postureOptions: ReadonlyArray<
      ['audience' | 'requiredTenantId' | 'requiredClientId', unknown]
    > = [
      ['audience', audience],
      ['requiredTenantId', requiredTenantId],
      ['requiredClientId', requiredClientId],
    ];
    for (const [name, value] of postureOptions) {
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        return { ok: false, error: CONFIG_INVALID_OPTION(name) };
      }
    }

    if (audience === undefined && requiredTenantId === undefined) {
      return { ok: false, error: CONFIG_MISSING_PIN() };
    }

    const rawTolerance =
      typeof opts.clockTolerance === 'number' && Number.isFinite(opts.clockTolerance)
        ? opts.clockTolerance
        : DEFAULT_CLOCK_TOLERANCE;
    const clockTolerance = Math.min(Math.max(0, rawTolerance), MAX_CLOCK_TOLERANCE);

    const jwksCache = getMemoizedJwksCache(jwksUrl);

    return await verifyTokenWithOptions<T>(token, jwksCache, {
      issuer,
      audience: audience ?? PLATFORM_AUDIENCE,
      clockTolerance,
      requireAccessTokenTyp: true,
      requiredTenantId,
      requiredClientId,
    });
  } catch {
    return { ok: false, error: TOKEN_MALFORMED() };
  }
}

interface VerifyRakomiTokenAudienceShape {
  issuer?: string;
  jwksUrl?: string;
  clockTolerance?: number;
  audience?: string;
  requiredTenantId?: string;
  requiredClientId?: string;
}

const VALID_BEARER_METHODS = new Set(['header', 'body', 'query']);

/**
 * Build the RFC 9728 §2 Protected Resource Metadata document for YOUR
 * resource server (not Rakomi's own) — serve it at your
 * `/.well-known/oauth-protected-resource[/path]` endpoint.
 *
 * Pure function over caller-supplied constants: no I/O, and never feed it
 * request-derived values (`Host` headers etc.) — a request-derived URL in a
 * discovery document is a token-phishing pivot.
 *
 * Throws a typed `RakomiError` on invalid input — this is a boot-time
 * builder, so failing fast beats serving a malformed discovery document (a
 * deliberate contrast with the never-throws verify surface). The emitted
 * field set is deliberately minimal per RFC 9728 §2; other registered fields
 * exist in the IANA registry, and there is no passthrough bag for arbitrary
 * extras. An empty `scopesSupported` array is treated as "nothing to
 * advertise" — the optional field is omitted rather than emitted empty.
 */
export function buildProtectedResourceMetadata(
  options: ProtectedResourceMetadataOptions,
): ProtectedResourceMetadata {
  const { resource, authorizationServers, scopesSupported, bearerMethodsSupported, resourceName } = options;

  if (typeof resource !== 'string' || !isHttpsUrl(resource) || resource.includes('#')) {
    throw new RakomiError(CONFIG_INVALID_RESOURCE());
  }

  const servers = authorizationServers ?? DEFAULT_AUTHORIZATION_SERVERS;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new RakomiError(
      CONFIG_INVALID_RESOURCE('authorizationServers must be a non-empty array of https: issuer URLs'),
    );
  }
  for (const server of servers) {
    if (!isHttpsUrl(server) || server.includes('#') || server.includes('?')) {
      throw new RakomiError(
        CONFIG_INVALID_RESOURCE('authorizationServers entries must be https: issuer URLs without query or fragment'),
      );
    }
  }

  if (scopesSupported !== undefined) {
    if (!Array.isArray(scopesSupported)) {
      throw new RakomiError(
        CONFIG_INVALID_RESOURCE('scopesSupported must be an array of RFC 6749 §3.3 scope tokens'),
      );
    }
    for (const scope of scopesSupported) {
      if (!isValidScopeToken(scope)) {
        throw new RakomiError(
          CONFIG_INVALID_RESOURCE('scopesSupported entries must be RFC 6749 §3.3 scope tokens'),
        );
      }
    }
  }

  const bearerMethods = bearerMethodsSupported ?? ['header'];
  if (!Array.isArray(bearerMethods) || bearerMethods.length === 0) {
    throw new RakomiError(
      CONFIG_INVALID_RESOURCE('bearerMethodsSupported must be a non-empty array of bearer methods'),
    );
  }
  for (const method of bearerMethods) {
    if (!VALID_BEARER_METHODS.has(method)) {
      throw new RakomiError(
        CONFIG_INVALID_RESOURCE('bearerMethodsSupported entries must be "header", "body" or "query"'),
      );
    }
  }

  if (resourceName !== undefined && (typeof resourceName !== 'string' || hasControlCharacters(resourceName))) {
    throw new RakomiError(CONFIG_INVALID_RESOURCE('resourceName must not contain control characters'));
  }

  return {
    resource,
    authorization_servers: [...servers],
    ...(scopesSupported !== undefined && scopesSupported.length > 0
      ? { scopes_supported: [...scopesSupported] }
      : {}),
    bearer_methods_supported: [...bearerMethods],
    ...(resourceName !== undefined ? { resource_name: resourceName } : {}),
  };
}

/**
 * Build the `WWW-Authenticate` header value your resource server returns on
 * 401/403 (RFC 9728 §5.1 / RFC 6750 §3.1), pointing clients at your
 * protected resource metadata. Pair it with `verifyRakomiToken()`:
 *
 * ```ts
 * const result = await verifyRakomiToken(token, { audience: RESOURCE_ID });
 * if (!result.ok) {
 *   res.status(401)
 *     .set('WWW-Authenticate', buildChallenge({ resourceMetadataUrl: PRM_URL, error: 'invalid_token' }))
 *     .end();
 * }
 * ```
 *
 * This builds the challenge for YOUR resource server — it is unrelated to the
 * challenge Rakomi's own hosted endpoints emit.
 *
 * Output shape: `Bearer ` + comma-joined `name="value"` params in the order
 * `error` (when present), `resource_metadata`, `scope` (when present). The
 * order is an output-stability guarantee of this function, not a protocol
 * requirement — RFC 9110 §11.2 consumers must not parse positionally. Values
 * are RFC 9110 §5.6.4 quoted-strings.
 *
 * `error` is a closed union — `invalid_token` | `insufficient_scope`. The
 * third RFC 6750 code, `invalid_request`, is deliberately excluded: a 400
 * response does not carry this challenge. Omit `error` entirely when no
 * token was presented (RFC 6750 §3.1).
 *
 * Throws a typed `RakomiError` on invalid input (control characters, illegal
 * scope tokens, non-https metadata URL) — inputs are boot-time constants, so
 * the throw fires on first use of a bad constant, never silently strips.
 */
export function buildChallenge(options: ChallengeOptions): string {
  const { resourceMetadataUrl, scope, error } = options;

  if (error !== undefined && error !== 'invalid_token' && error !== 'insufficient_scope') {
    throw new RakomiError(
      CONFIG_INVALID_CHALLENGE_PARAM('error must be "invalid_token" or "insufficient_scope"'),
    );
  }

  if (!isHttpsUrl(resourceMetadataUrl)) {
    throw new RakomiError(
      CONFIG_INVALID_CHALLENGE_PARAM('resourceMetadataUrl must be a valid HTTPS URL'),
    );
  }

  if (scope !== undefined && !isValidScopeList(scope)) {
    throw new RakomiError(
      CONFIG_INVALID_CHALLENGE_PARAM('scope must be space-separated RFC 6749 §3.3 scope tokens'),
    );
  }

  const params: string[] = [];
  if (error !== undefined) {
    params.push(writeChallengeParam('error', error));
  }
  params.push(writeChallengeParam('resource_metadata', resourceMetadataUrl));
  if (scope !== undefined) {
    params.push(writeChallengeParam('scope', scope));
  }
  return `Bearer ${params.join(', ')}`;
}

/**
 * The ONE param writer all challenge params go through: rejects control
 * characters (escaping alone does not stop header injection when the value
 * is written into a real `WWW-Authenticate` header), then emits an RFC 9110
 * §5.6.4 quoted-string with `"` and `\` escaped.
 */
function writeChallengeParam(name: string, value: string): string {
  if (typeof value !== 'string' || hasControlCharacters(value)) {
    throw new RakomiError(
      CONFIG_INVALID_CHALLENGE_PARAM(`${name} must not contain control characters`),
    );
  }
  return `${name}="${escapeQuotedString(value)}"`;
}

/** Linear scan for CTL bytes (0x00-0x1F, 0x7F) — CR/LF included. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** RFC 9110 §5.6.4 quoted-string escaping (`\` and `"`), single linear pass. */
function escapeQuotedString(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' || ch === '\\') {
      out += '\\';
    }
    out += ch;
  }
  return out;
}

/** RFC 6749 §3.3 scope-token: 1*( %x21 / %x23-5B / %x5D-7E ). Linear scan. */
function isValidScopeToken(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const legal = code === 0x21 || (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e);
    if (!legal) {
      return false;
    }
  }
  return true;
}

/** Space-separated non-empty scope tokens (no leading/trailing/double spaces). */
function isValidScopeList(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  for (const token of value.split(' ')) {
    if (!isValidScopeToken(token)) {
      return false;
    }
  }
  return true;
}
