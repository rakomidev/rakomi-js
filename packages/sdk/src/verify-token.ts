import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';

import {
  guardAcr,
  guardAmr,
  guardOrgId,
  guardOrgMemberships,
  guardOrgRole,
  guardPermissions,
  guardPublicMetadata,
  guardRoles,
  guardSubscription,
} from './claim-guards.js';
import {
  AUTH_ENVIRONMENT_MISMATCH,
  TOKEN_CLIENT_MISMATCH,
  TOKEN_EXPIRED,
  TOKEN_INVALID_ALGORITHM,
  TOKEN_INVALID_AUDIENCE,
  TOKEN_INVALID_ISSUER,
  TOKEN_INVALID_SIGNATURE,
  TOKEN_MALFORMED,
  TOKEN_MISSING_CLAIMS,
  TOKEN_NOT_YET_VALID,
  TOKEN_REVOKED,
  TOKEN_TENANT_MISMATCH,
} from './errors.js';
import type { JwksCache } from './jwks-cache.js';
import type { SessionMetadata, TokenMetadata, TokenPayload, VerifyResult } from './types.js';

const ISSUER = 'https://api.rakomi.com';
const AUDIENCE = 'https://api.rakomi.com';
const ALLOWED_ALGORITHMS = ['RS256'] as const;

const REQUIRED_CLAIMS = ['sub', 'tenant_id', 'iss', 'aud', 'exp', 'iat', 'jti'];
const USER_REQUIRED_CLAIMS = ['email', 'sid'];

function isDevMode(): boolean {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.['NODE_ENV'] !== 'production';
}

function describeClaimType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

const warnedClaimNames = new Set<string>();
function warnMalformedClaim(claimName: string, expected: string, actualType: string): void {
  if (!isDevMode()) return;
  if (warnedClaimNames.has(claimName)) return;
  warnedClaimNames.add(claimName);
  console.warn(
    `[@rakomi/node] Malformed JWT claim "${claimName}": expected ${expected}, got ${actualType}. Claim omitted.`,
  );
}

function warnIfArrayDropped(claimName: string, raw: unknown, guarded: unknown[] | undefined, expected: string): void {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    warnMalformedClaim(claimName, expected, describeClaimType(raw));
    return;
  }
  if ((guarded ?? []).length !== raw.length) {
    warnMalformedClaim(claimName, expected, 'array with one or more malformed entries');
  }
}

function warnIfScalarDropped(claimName: string, raw: unknown, guarded: unknown, expected: string): void {
  if (raw === undefined || raw === null) return;
  if (guarded === undefined) {
    warnMalformedClaim(claimName, expected, describeClaimType(raw));
  }
}

/**
 * Options for the shared verification core. Module-internal — consumed by
 * `verifyToken()` (frozen platform constants) and by the standalone
 * resource-server verify path (caller-supplied expected values + pins).
 * All jose calls stay inside this module: one migration point if jose majors.
 */
export interface VerifyTokenCoreOptions {
  issuer: string;
  audience: string;
  clockTolerance: number;
  sdkEnvironment?: 'live' | 'test';
  /**
   * When true, the JWT header `typ` must identify an OAuth access token
   * (`at+jwt` / `application/at+jwt`, RFC 9068 §2.1/§4, case-insensitive).
   * Blocks cross-JWT confusion: an id_token (`typ: JWT`) presented as a
   * bearer access token is rejected before any claim is trusted.
   */
  requireAccessTokenTyp?: boolean;
  /** Reject unless the token's `tenant_id` claim equals this value (absent claim ⇒ reject). */
  requiredTenantId?: string;
  /** Reject unless the token's `client_id` claim equals this value (absent claim ⇒ reject). */
  requiredClientId?: string;
}

export async function verifyToken<T extends TokenPayload = TokenPayload>(
  token: string,
  jwksCache: JwksCache,
  clockTolerance: number,
  sdkEnvironment?: 'live' | 'test',
): Promise<VerifyResult<T>> {
  return verifyTokenWithOptions<T>(token, jwksCache, {
    issuer: ISSUER,
    audience: AUDIENCE,
    clockTolerance,
    sdkEnvironment,
  });
}

/**
 * Shared verification core. Not exported from the package root — the public
 * entry points are `verifyToken()` (via `RakomiClient`) and
 * `verifyRakomiToken()` (standalone resource-server helper).
 */
export async function verifyTokenWithOptions<T extends TokenPayload = TokenPayload>(
  token: string,
  jwksCache: JwksCache,
  options: VerifyTokenCoreOptions,
): Promise<VerifyResult<T>> {
  const { issuer, audience, clockTolerance, sdkEnvironment } = options;

  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256') {
      return { ok: false, error: TOKEN_INVALID_ALGORITHM() };
    }
    if (options.requireAccessTokenTyp) {
      const typ = typeof header.typ === 'string' ? header.typ.toLowerCase() : '';
      if (typ !== 'at+jwt' && typ !== 'application/at+jwt') {
        return { ok: false, error: TOKEN_MALFORMED() };
      }
    }
    kid = header.kid;
  } catch {
    return { ok: false, error: TOKEN_MALFORMED() };
  }

  if (!kid) {
    return { ok: false, error: TOKEN_MALFORMED() };
  }

  const keyResult = await jwksCache.getKey(kid);
  if (!keyResult.ok) {
    return keyResult;
  }

  try {
    const { payload } = await jwtVerify(token, keyResult.data, {
      algorithms: [...ALLOWED_ALGORITHMS],
      issuer,
      audience,
      clockTolerance,
      maxTokenAge: '3660s',
    });

    if (Array.isArray(payload.aud)) {
      return { ok: false, error: TOKEN_INVALID_AUDIENCE() };
    }

    if (options.requiredTenantId !== undefined && payload.tenant_id !== options.requiredTenantId) {
      return { ok: false, error: TOKEN_TENANT_MISMATCH() };
    }
    if (options.requiredClientId !== undefined && payload.client_id !== options.requiredClientId) {
      return { ok: false, error: TOKEN_CLIENT_MISMATCH() };
    }

    for (const claim of REQUIRED_CLAIMS) {
      if (payload[claim] === undefined || payload[claim] === null) {
        return { ok: false, error: TOKEN_MISSING_CLAIMS() };
      }
    }

    const isM2MToken = payload.m2m === true;
    if (!isM2MToken) {
      for (const claim of USER_REQUIRED_CLAIMS) {
        if (payload[claim] === undefined || payload[claim] === null) {
          return { ok: false, error: TOKEN_MISSING_CLAIMS() };
        }
      }
    }

    const epoch = jwksCache.getRevocationEpoch();
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (epoch && epoch > 0 && epoch <= nowSeconds) {
      if (payload.iat === undefined || payload.iat < epoch) {
        return { ok: false, error: TOKEN_REVOKED() };
      }
    }

    if (sdkEnvironment && payload.rkm_env) {
      const tokenEnv = payload.rkm_env as string;
      const sdkIsLive = sdkEnvironment === 'live';
      const tokenIsLive = tokenEnv === 'live';
      if (sdkIsLive !== tokenIsLive) {
        return { ok: false, error: AUTH_ENVIRONMENT_MISMATCH() };
      }
    }

    const guardedRoles = guardRoles(payload.roles);
    warnIfArrayDropped('roles', payload.roles, guardedRoles, 'array of strings');
    const guardedPermissions = guardPermissions(payload.permissions);
    warnIfArrayDropped('permissions', payload.permissions, guardedPermissions, 'array of strings');
    const guardedAmr = guardAmr(payload.amr);
    warnIfArrayDropped('amr', payload.amr, guardedAmr, 'array of strings');
    const guardedAcr = payload.acr ? guardAcr(payload.acr) : undefined;
    warnIfScalarDropped('acr', payload.acr, guardAcr(payload.acr), 'string');
    const guardedPublicMetadata = payload.public_metadata ? guardPublicMetadata(payload.public_metadata) : undefined;
    warnIfScalarDropped('publicMetadata', payload.public_metadata, guardPublicMetadata(payload.public_metadata), 'plain object');
    const guardedSubscription = payload.subscription ? guardSubscription(payload.subscription) : undefined;
    warnIfScalarDropped(
      'subscription',
      payload.subscription,
      guardSubscription(payload.subscription),
      'object with plan_id/plan_name/status/current_period_end',
    );
    const guardedOrgId = guardOrgId(payload.org_id);
    warnIfScalarDropped('org_id', payload.org_id, guardedOrgId, 'string or null');
    const guardedOrgRole = guardOrgRole(payload.org_role);
    warnIfScalarDropped('org_role', payload.org_role, guardedOrgRole, 'string or null');
    const guardedOrgMemberships = guardOrgMemberships(payload.org_memberships);
    warnIfArrayDropped(
      'org_memberships',
      payload.org_memberships,
      guardedOrgMemberships,
      'array of org membership objects',
    );

    const mapped: TokenPayload = {
      userId: payload.sub as string,
      ...(payload.email ? { email: payload.email as string } : {}),
      tenantId: payload.tenant_id as string,
      ...(payload.sid ? { sessionId: payload.sid as string } : {}),
      iss: payload.iss as string,
      aud: (Array.isArray(payload.aud) ? payload.aud[0] : payload.aud) as string,
      exp: payload.exp as number,
      iat: payload.iat as number,
      jti: payload.jti as string,
      ...(payload.mfa_verified === true ? {
        mfaVerified: true,
        mfaVerifiedAt: payload.mfa_verified_at as string | undefined,
      } : {}),
      ...(guardedAmr !== undefined ? { amr: guardedAmr } : {}),
      ...(guardedAcr !== undefined ? { acr: guardedAcr } : {}),
      ...(payload.auth_time != null ? { authTime: payload.auth_time as number } : {}),
      roles: guardedRoles ?? [],
      permissions: guardedPermissions ?? [],
      ...(payload.rkm_env ? { environment: payload.rkm_env as string } : {}),
      ...(guardedPublicMetadata !== undefined ? { publicMetadata: guardedPublicMetadata } : {}),
      ...(typeof payload.is_minor === 'boolean' ? { isMinor: payload.is_minor } : {}),
      ...(guardedSubscription !== undefined ? { subscription: guardedSubscription } : {}),
      ...(guardedOrgId !== undefined ? { org_id: guardedOrgId } : {}),
      ...(guardedOrgRole !== undefined ? { org_role: guardedOrgRole } : {}),
      ...(guardedOrgMemberships !== undefined ? { org_memberships: guardedOrgMemberships } : {}),
      ...(payload.m2m === true ? { isM2M: true } : {}),
      ...(payload.client_id ? { clientId: payload.client_id as string } : {}),
      ...(payload.scope ? { scopes: (payload.scope as string).split(' ').filter(Boolean) } : {}),
    };

    const actClaim = payload.act as { sub?: unknown } | undefined | null;
    if (actClaim && typeof actClaim === 'object' && typeof actClaim.sub === 'string') {
      mapped.isAgentToken = true;
      const tokenScopes = typeof payload.scope === 'string'
        ? (payload.scope as string).split(' ').filter(Boolean)
        : [];
      mapped.agent = { clientId: actClaim.sub, scopes: tokenScopes };
    }

    if (!mapped.isM2M) {
      const nowSecondsForMeta = Math.floor(Date.now() / 1000);
      const expiresIn = Math.max(0, (payload.exp as number) - nowSecondsForMeta);

      const tokenMeta: TokenMetadata = { expiresIn };

      const session: SessionMetadata = {
        expiresAt: new Date((payload.exp as number) * 1000).toISOString(),
        isExpiringSoon: false,
      };

      if (typeof payload.session_max_lifetime_exp === 'number') {
        session.maxLifetimeExpiresAt = new Date(payload.session_max_lifetime_exp * 1000).toISOString();
      }

      const maxLifeRemaining = typeof payload.session_max_lifetime_exp === 'number'
        ? Math.max(0, payload.session_max_lifetime_exp - nowSecondsForMeta)
        : Infinity;
      session.isExpiringSoon = Math.min(tokenMeta.expiresIn, maxLifeRemaining) < 300;

      mapped.session = session;
      mapped.token = tokenMeta;
    }

    return { ok: true, data: mapped as T };
  } catch (err) {
    return { ok: false, error: mapJoseError(err) };
  }
}

function mapJoseError(err: unknown) {
  if (err instanceof joseErrors.JWTExpired) {
    return TOKEN_EXPIRED();
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return TOKEN_INVALID_SIGNATURE();
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') {
      return TOKEN_INVALID_ISSUER();
    }
    if (err.claim === 'aud') {
      return TOKEN_INVALID_AUDIENCE();
    }
    if (err.claim === 'nbf') {
      return TOKEN_NOT_YET_VALID();
    }
    return TOKEN_MISSING_CLAIMS();
  }
  if (err instanceof joseErrors.JOSEError) {
    return TOKEN_MALFORMED();
  }
  return TOKEN_MALFORMED();
}
