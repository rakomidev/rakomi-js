
/** The JWS algorithms a Rakomi-issued token may be signed with. `none` and HMAC are never accepted. */
export const ALLOWED_SIGNING_ALGORITHMS = ['RS256', 'PS256', 'ES256'] as const;

export type AllowedSigningAlgorithm = (typeof ALLOWED_SIGNING_ALGORITHMS)[number];

export function isAllowedSigningAlgorithm(alg: unknown): alg is AllowedSigningAlgorithm {
  return typeof alg === 'string' && (ALLOWED_SIGNING_ALGORITHMS as readonly string[]).includes(alg);
}

/**
 * `true` when a JWK may verify a Rakomi token signature: it has a `kid`, names an allowed `alg`,
 * `use` is absent or `sig`, and the key type matches the algorithm (RSA for RS256/PS256, EC P-256
 * for ES256).
 */
export function isAcceptableSigningJwk(jwk: Record<string, unknown>): boolean {
  if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (!isAllowedSigningAlgorithm(jwk.alg)) return false;
  if (jwk.alg === 'ES256') return jwk.kty === 'EC' && jwk.crv === 'P-256';
  return jwk.kty === 'RSA';
}
