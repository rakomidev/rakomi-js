// SPDX-License-Identifier: MIT
// Copyright (c) CRE8EVE Sp. z o.o.

import type { JWK } from 'jose';
import { base64url, calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';

import { TOKEN_INVALID_DPOP_PROOF } from './errors.js';
import { canonicalizeUrl } from './internal/canonical-url.js';
import type { DpopProofRejectionReason, DpopVerifyOptions, SdkError } from './types.js';

/** Accepted proof algorithms (asymmetric only) and the only key shape each may use. */
export const DPOP_PROOF_ALGS = ['ES256', 'EdDSA'] as const;
const NATURAL_PAIRING: Record<string, Record<string, string>> = {
  EC: { 'P-256': 'ES256' },
  OKP: { Ed25519: 'EdDSA' },
};
/** Public members allowed in the proof's `jwk` header, per key type. */
const PUBLIC_JWK_MEMBERS: Record<string, readonly string[]> = {
  EC: ['kty', 'crv', 'x', 'y'],
  OKP: ['kty', 'crv', 'x'],
};

/** Proof `iat` acceptance window, seconds (RFC 9449 §11.1). */
export const DPOP_IAT_PAST_WINDOW_SECONDS = 60;
export const DPOP_IAT_FUTURE_WINDOW_SECONDS = 5;

const JTI_MIN_LENGTH = 22;
const JTI_MAX_LENGTH = 128;

/** Value for a `WWW-Authenticate` response header after a DPoP rejection (RFC 9449 §7.1). */
export const DPOP_WWW_AUTHENTICATE = `DPoP error="invalid_dpop_proof", algs="${DPOP_PROOF_ALGS.join(' ')}"`;

class DpopRejection extends Error {
  constructor(readonly reason: DpopProofRejectionReason) {
    super(reason);
  }
}

function reject(reason: DpopProofRejectionReason): never {
  throw new DpopRejection(reason);
}

function isJtiShape(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < JTI_MIN_LENGTH || value.length > JTI_MAX_LENGTH) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
    if (!ok) return false;
  }
  return true;
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}

/** Constant-time string comparison over equal-length inputs. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Exactly one proof value. A JWS compact serialization never contains `,` or whitespace, so a
 * comma in a single string means the transport folded two `DPoP` headers into one.
 */
function singleProof(proof: DpopVerifyOptions['proof']): string {
  let value: unknown = proof;
  if (Array.isArray(value)) {
    if (value.length === 0) reject('proof_required');
    if (value.length > 1) reject('multi_header');
    value = value[0];
  }
  if (typeof value !== 'string' || value.trim() === '') reject('proof_required');
  const trimmed = value.trim();
  if (trimmed.includes(',')) reject('multi_header');
  return trimmed;
}

function canonical(url: string, reason: DpopProofRejectionReason): string {
  try {
    return canonicalizeUrl(url);
  } catch {
    return reject(reason);
  }
}

async function checkProof(
  accessToken: string,
  cnfJkt: string,
  options: DpopVerifyOptions,
): Promise<void> {
  const proof = singleProof(options.proof);

  if (typeof options.method !== 'string' || options.method === '') reject('request_context_missing');
  if (typeof options.url !== 'string' || options.url === '') reject('request_context_missing');
  const expectedHtu = canonical(options.url, 'request_context_missing');

  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(proof) as Record<string, unknown>;
  } catch {
    reject('malformed');
  }
  if (header.typ !== 'dpop+jwt') reject('typ_rejected');
  if ('kid' in header) reject('kid_forbidden');
  for (const banned of ['x5c', 'jku', 'x5u']) {
    if (banned in header) reject('malformed');
  }
  if ('crit' in header) reject('crit_rejected');
  const alg = header.alg;
  if (typeof alg !== 'string' || !(DPOP_PROOF_ALGS as readonly string[]).includes(alg)) {
    reject('alg_rejected');
  }

  const rawJwk = header.jwk;
  if (!rawJwk || typeof rawJwk !== 'object' || Array.isArray(rawJwk)) reject('malformed');
  const jwkRecord = rawJwk as Record<string, unknown>;
  const kty = jwkRecord.kty;
  const allowedMembers = typeof kty === 'string' ? PUBLIC_JWK_MEMBERS[kty] : undefined;
  if (!allowedMembers) reject('alg_rejected');
  for (const member of Object.keys(jwkRecord)) {
    if (!allowedMembers.includes(member)) reject('private_jwk_params');
  }
  for (const member of allowedMembers) {
    if (typeof jwkRecord[member] !== 'string') reject('malformed');
  }
  const pairing = NATURAL_PAIRING[kty as string]!;
  const crv = jwkRecord.crv as string;
  if (!Object.prototype.hasOwnProperty.call(pairing, crv) || pairing[crv] !== alg) reject('alg_rejected');
  const jwk = jwkRecord as JWK;

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk, alg);
    const verified = await jwtVerify(proof, key, { algorithms: [alg] });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    reject('signature_invalid');
  }

  if (payload.htm !== options.method) reject('htm_mismatch');
  if (typeof payload.htu !== 'string' || canonical(payload.htu, 'htu_mismatch') !== expectedHtu) {
    reject('htu_mismatch');
  }

  const iat = payload.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) reject('iat_window');
  const skew = Math.floor(Date.now() / 1000) - iat;
  if (skew > DPOP_IAT_PAST_WINDOW_SECONDS || skew < -DPOP_IAT_FUTURE_WINDOW_SECONDS) reject('iat_window');

  if (!isJtiShape(payload.jti)) reject('jti_invalid');
  const jti = payload.jti;

  if (typeof payload.ath !== 'string') reject('ath_missing');
  if (!safeEqual(payload.ath, await sha256Base64url(accessToken))) reject('ath_mismatch');

  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  if (jkt !== cnfJkt) reject('jkt_mismatch');

  if (options.onJti) {
    let fresh: boolean;
    try {
      fresh = await options.onJti(jti, {
        jkt,
        iat,
        expiresAt: iat + DPOP_IAT_PAST_WINDOW_SECONDS,
      });
    } catch {
      reject('replay_check_unavailable');
    }
    if (fresh !== true) reject('jti_replay');
  }
}

/**
 * Decide the DPoP binding for an already signature-verified access-token payload.
 *
 * - No `cnf` claim: returns `null` — nothing to enforce, the token is not sender-constrained.
 * - `cnf` present: the token is accepted only with a DPoP proof that passes every check in
 *   `checkProof()`; otherwise returns the `token/invalid_dpop_proof` error.
 */
export async function enforceDpopBinding(
  accessToken: string,
  payload: Record<string, unknown>,
  options: DpopVerifyOptions | undefined,
): Promise<SdkError | null> {
  const cnf = payload.cnf;
  if (cnf === undefined || cnf === null) return null;
  try {
    if (typeof cnf !== 'object' || Array.isArray(cnf)) reject('malformed');
    const cnfJkt = (cnf as Record<string, unknown>).jkt;
    if (cnfJkt === undefined) {
      reject('unsupported_confirmation');
    }
    if (typeof cnfJkt !== 'string' || cnfJkt === '') reject('malformed');
    if (!options) reject('proof_required');
    await checkProof(accessToken, cnfJkt, options);
    return null;
  } catch (err) {
    return TOKEN_INVALID_DPOP_PROOF(err instanceof DpopRejection ? err.reason : 'malformed');
  }
}
