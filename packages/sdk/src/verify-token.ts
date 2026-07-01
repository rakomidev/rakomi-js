import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';

import {
  AUTH_ENVIRONMENT_MISMATCH,
  TOKEN_EXPIRED,
  TOKEN_INVALID_ALGORITHM,
  TOKEN_INVALID_AUDIENCE,
  TOKEN_INVALID_ISSUER,
  TOKEN_INVALID_SIGNATURE,
  TOKEN_MALFORMED,
  TOKEN_MISSING_CLAIMS,
  TOKEN_NOT_YET_VALID,
  TOKEN_REVOKED,
} from './errors.js';
import type { JwksCache } from './jwks-cache.js';
import type { SessionMetadata, TokenMetadata, TokenPayload, VerifyResult } from './types.js';

const ISSUER = 'https://rakomi.com';
const AUDIENCE = 'https://rakomi.com';
const ALLOWED_ALGORITHMS = ['RS256'] as const;

const REQUIRED_CLAIMS = ['sub', 'tenant_id', 'iss', 'aud', 'exp', 'iat', 'jti'];
const USER_REQUIRED_CLAIMS = ['email', 'sid'];

export async function verifyToken<T extends TokenPayload = TokenPayload>(
  token: string,
  jwksCache: JwksCache,
  clockTolerance: number,
  sdkEnvironment?: 'live' | 'test',
): Promise<VerifyResult<T>> {
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256') {
      return { ok: false, error: TOKEN_INVALID_ALGORITHM() };
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
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance,
      maxTokenAge: '3660s',
    });

    if (Array.isArray(payload.aud)) {
      return { ok: false, error: TOKEN_INVALID_AUDIENCE() };
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
      ...(payload.amr ? { amr: payload.amr as string[] } : {}),
      ...(payload.acr ? { acr: payload.acr as string } : {}),
      ...(payload.auth_time != null ? { authTime: payload.auth_time as number } : {}),
      roles: (payload.roles as string[]) ?? [],
      permissions: (payload.permissions as string[]) ?? [],
      ...(payload.rkm_env ? { environment: payload.rkm_env as string } : {}),
      ...(payload.public_metadata ? { publicMetadata: payload.public_metadata as Record<string, unknown> } : {}),
      ...(typeof payload.is_minor === 'boolean' ? { isMinor: payload.is_minor } : {}),
      ...(payload.subscription ? { subscription: payload.subscription as TokenPayload['subscription'] } : {}),
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
