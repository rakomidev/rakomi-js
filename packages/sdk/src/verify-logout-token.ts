// SPDX-License-Identifier: MIT
// Copyright (c) CRE8EVE Sp. z o.o.

import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';

import {
  LOGOUT_TOKEN_INVALID_EVENTS,
  LOGOUT_TOKEN_MISSING_CLAIMS,
  LOGOUT_TOKEN_MISSING_SUBJECT,
  LOGOUT_TOKEN_NONCE_PRESENT,
  LOGOUT_TOKEN_SESSION_MISMATCH,
  TOKEN_EXPIRED,
  TOKEN_INVALID_ALGORITHM,
  TOKEN_INVALID_AUDIENCE,
  TOKEN_INVALID_ISSUER,
  TOKEN_INVALID_SIGNATURE,
  TOKEN_MALFORMED,
  TOKEN_NOT_YET_VALID,
} from './errors.js';
import { JwksCache } from './jwks-cache.js';
import type { LogoutTokenPayload, VerifyLogoutTokenOptions, VerifyResult } from './types.js';

const DEFAULT_ISSUER = 'https://api.rakomi.com';
const DEFAULT_JWKS_URL = 'https://api.rakomi.com/.well-known/jwks.json';
const DEFAULT_CLOCK_TOLERANCE = 30;
const MAX_CLOCK_TOLERANCE = 120;

const BACKCHANNEL_LOGOUT_EVENT_MEMBER = 'http://schemas.openid.net/event/backchannel-logout';

const LOGOUT_TOKEN_TYP = 'logout+jwt';

const LOGOUT_TOKEN_MAX_AGE_SECONDS = 300;

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

export function __resetLogoutTokenJwksMemoForTesting(): void {
  jwksMemo.clear();
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function hasBackchannelLogoutEvent(events: unknown): events is Record<string, unknown> {
  return (
    events !== null &&
    typeof events === 'object' &&
    !Array.isArray(events) &&
    BACKCHANNEL_LOGOUT_EVENT_MEMBER in (events as Record<string, unknown>)
  );
}

/**
 * Verify an OIDC Back-Channel Logout 1.0 `logout_token` your `backchannel_logout_uri` endpoint
 * received (§2.5 — POSTed `application/x-www-form-urlencoded`, the `logout_token` form field).
 * NEVER throws — every failure is a `{ ok: false, error }` result. On a failed result your handler
 * MUST respond HTTP 400 (§2.6) and MUST NOT log any session out.
 *
 * Performs every §2.6 validation step this SDK can decide without your session store: signature +
 * `alg` (RS256 only — `alg: none` is rejected, step 3), `iss`/`aud`/`iat`/`exp` (step 4), presence
 * of `sub` or `sid` (step 5), the `events` member (step 6), and ABSENCE of a `nonce` claim (step 7
 * — a Logout Token carrying one is a forged or misissued token, never a valid one to silently
 * ignore). Two steps stay yours because they need YOUR session store, not this SDK's: replay
 * detection by `jti` (§2.6 step 8 — dedupe against your own store; the returned `jti` is what you
 * dedupe on) and matching `sid`/`sub` against the RP session you are about to end (§2.6 steps
 * 10-11) — pass `expectedSid`/`expectedSub` to have this function do that comparison for you.
 *
 * Encrypted Logout Tokens (§2.6 step 1) are out of scope: Rakomi issues signed-only (JWS) tokens,
 * never JWE, so this helper does not attempt decryption.
 */
export async function verifyLogoutToken(
  token: string,
  options: VerifyLogoutTokenOptions,
): Promise<VerifyResult<LogoutTokenPayload>> {
  try {
    const issuer = options?.issuer ?? DEFAULT_ISSUER;
    const jwksUrl = options?.jwksUrl ?? DEFAULT_JWKS_URL;

    if (!isHttpsUrl(issuer)) {
      return { ok: false, error: TOKEN_INVALID_ISSUER() };
    }
    if (!isHttpsUrl(jwksUrl)) {
      return { ok: false, error: TOKEN_MALFORMED() };
    }
    if (typeof options?.audience !== 'string' || options.audience.trim() === '') {
      return { ok: false, error: LOGOUT_TOKEN_MISSING_CLAIMS() };
    }

    const rawTolerance =
      typeof options.clockTolerance === 'number' && Number.isFinite(options.clockTolerance)
        ? options.clockTolerance
        : DEFAULT_CLOCK_TOLERANCE;
    const clockTolerance = Math.min(Math.max(0, rawTolerance), MAX_CLOCK_TOLERANCE);

    let kid: string | undefined;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'RS256') {
        return { ok: false, error: TOKEN_INVALID_ALGORITHM() };
      }
      const typ = typeof header.typ === 'string' ? header.typ.toLowerCase() : '';
      if (typ !== LOGOUT_TOKEN_TYP) {
        return { ok: false, error: TOKEN_MALFORMED() };
      }
      kid = header.kid;
    } catch {
      return { ok: false, error: TOKEN_MALFORMED() };
    }
    if (!kid) {
      return { ok: false, error: TOKEN_MALFORMED() };
    }

    const jwksCache = getMemoizedJwksCache(jwksUrl);
    const keyResult = await jwksCache.getKey(kid);
    if (!keyResult.ok) {
      return keyResult;
    }

    const { payload } = await jwtVerify(token, keyResult.data, {
      algorithms: ['RS256'],
      issuer,
      audience: options.audience,
      clockTolerance,
      maxTokenAge: `${LOGOUT_TOKEN_MAX_AGE_SECONDS}s`,
    });

    if (Array.isArray(payload.aud)) {
      return { ok: false, error: TOKEN_INVALID_AUDIENCE() };
    }

    if (payload.nonce !== undefined) {
      return { ok: false, error: LOGOUT_TOKEN_NONCE_PRESENT() };
    }

    if (!hasBackchannelLogoutEvent(payload.events)) {
      return { ok: false, error: LOGOUT_TOKEN_INVALID_EVENTS() };
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
    if (sub === undefined && sid === undefined) {
      return { ok: false, error: LOGOUT_TOKEN_MISSING_SUBJECT() };
    }

    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
      return { ok: false, error: LOGOUT_TOKEN_MISSING_CLAIMS() };
    }
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      return { ok: false, error: LOGOUT_TOKEN_MISSING_CLAIMS() };
    }

    if (options.expectedSid !== undefined && options.expectedSid !== sid) {
      return { ok: false, error: LOGOUT_TOKEN_SESSION_MISMATCH('sid does not match expectedSid') };
    }
    if (options.expectedSub !== undefined && options.expectedSub !== sub) {
      return { ok: false, error: LOGOUT_TOKEN_SESSION_MISMATCH('sub does not match expectedSub') };
    }

    const mapped: LogoutTokenPayload = {
      iss: payload.iss as string,
      aud: options.audience,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
      events: payload.events as Record<string, unknown>,
      ...(sub !== undefined ? { sub } : {}),
      ...(sid !== undefined ? { sid } : {}),
    };

    return { ok: true, data: mapped };
  } catch (err) {
    return { ok: false, error: mapLogoutTokenJoseError(err) };
  }
}

function mapLogoutTokenJoseError(err: unknown) {
  if (err instanceof joseErrors.JWTExpired) {
    return TOKEN_EXPIRED();
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return TOKEN_INVALID_SIGNATURE();
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return TOKEN_INVALID_ISSUER();
    if (err.claim === 'aud') return TOKEN_INVALID_AUDIENCE();
    if (err.claim === 'nbf') return TOKEN_NOT_YET_VALID();
    return LOGOUT_TOKEN_MISSING_CLAIMS();
  }
  if (err instanceof joseErrors.JOSEError) {
    return TOKEN_MALFORMED();
  }
  return TOKEN_MALFORMED();
}
