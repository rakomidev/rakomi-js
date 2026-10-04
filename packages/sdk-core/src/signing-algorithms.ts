import type { JWK } from 'jose';

/**
 * The JWS algorithms a Rakomi-issued token may be signed with. Anything else — `none`, every
 * HMAC (`HS*`) variant, and any algorithm not listed here — is rejected before a key is chosen.
 */
export const ALLOWED_SIGNING_ALGORITHMS = ['RS256', 'PS256', 'ES256'] as const;

/** One of {@link ALLOWED_SIGNING_ALGORITHMS}. */
export type AllowedSigningAlgorithm = (typeof ALLOWED_SIGNING_ALGORITHMS)[number];

/** `true` when `alg` is one of {@link ALLOWED_SIGNING_ALGORITHMS}. */
export function isAllowedSigningAlgorithm(alg: unknown): alg is AllowedSigningAlgorithm {
  return typeof alg === 'string' && (ALLOWED_SIGNING_ALGORITHMS as readonly string[]).includes(alg);
}

/**
 * `true` when a JWK may be used to verify a Rakomi token signature.
 *
 * The key must name its own algorithm (`alg`), that algorithm must be allowed, and the key type
 * must match it: RSA for `RS256`/`PS256`, an EC key on curve P-256 for `ES256`. A key published
 * for another use (`use` other than `sig`) or without a `kid` is never used. Binding the
 * algorithm to the key — never to the token header alone — means a token whose header names a
 * different algorithm than its key is rejected.
 */
export function isAcceptableSigningJwk(jwk: JWK): boolean {
  if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (!isAllowedSigningAlgorithm(jwk.alg)) return false;
  if (jwk.alg === 'ES256') return jwk.kty === 'EC' && jwk.crv === 'P-256';
  return jwk.kty === 'RSA';
}
