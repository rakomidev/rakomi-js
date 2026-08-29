// SPDX-License-Identifier: MIT

import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

export interface DpopKeyPair {
  readonly privateKeyPem: string;
  readonly publicJwk: Record<string, unknown>;
}

/**
 * A fresh, IN-MEMORY-ONLY EC P-256 keypair (ES256 — RFC 9449's EC natural pairing, matching the
 * server's `DPOP_NATURAL_PAIRING`). Never written to disk or a `KeyStore`. A caller needing a
 * DURABLE per-install key instead uses `install-key.ts`'s `getOrCreateInstallKey` and passes its
 * `{ privateKeyPem, publicJwk }` shape to `buildDpopProof` below — same two fields, which is what
 * makes this seam reusable rather than CI-specific.
 */
export function generateEphemeralDpopKey(): DpopKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { privateKeyPem, publicJwk };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * RFC 9449 §4.3 `htu` canonicalization — a minimal, standalone re-implementation of the shared
 * canonicalization helper the API server itself uses (this package ships ZERO runtime deps, so
 * importing that implementation is not an option — same discipline as `env.ts`'s
 * `isCimdClientId`). Implements exactly the rules this CLI's own request URLs can exercise:
 * lowercase scheme+host, strip an EXPLICIT default port, lowercase percent-encoded hex, strip
 * query/fragment, collapse repeated slashes, strip a non-root trailing slash. The two
 * implementations MUST agree for a URL of this shape. `dpop.test.ts` unit-tests each rule against
 * the documented canonicalization (default port present/absent, trailing slash, uppercase host);
 * there is NO automated cross-check against the shared helper — a drift between the two fails
 * CLOSED (the server recomputes `htu`, the proof mismatches, the call 401s), never open.
 */
export function canonicalizeHtu(input: string): string {
  const url = new URL(input);
  const protocol = url.protocol.toLowerCase();
  const isDefaultPort = (protocol === 'https:' && url.port === '443') || (protocol === 'http:' && url.port === '80');
  const host = (isDefaultPort ? url.hostname : url.host).toLowerCase();
  const lowerHexPath = url.pathname.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => `%${h.toLowerCase()}`);
  const collapsed = lowerHexPath.replace(/\/{2,}/g, '/');
  const path = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  return `${protocol}//${host}${path}`;
}

export interface DpopProofClaims {
  readonly htm: string;
  readonly htu: string;
  /** RFC 9449 §4.3 `ath` — present ONLY when binding a resource-server call to a specific access
   * token already in hand. Omitted on the token-ENDPOINT proof (no access token exists yet at that
   * point in the exchange — the server's own `resolveDpopForTokenEndpoint` never requires it there). */
  readonly accessToken?: string;
  /** RFC 9449 §8 — present only once a prior server `use_dpop_nonce` challenge supplied a nonce
   * (signalled via a `DPoP-Nonce` response header, never a body field — see `http.ts`'s retry
   * logic). Absent on every other proof. */
  readonly nonce?: string;
}

/**
 * Builds one RFC 9449 DPoP proof JWT (ES256, single-use `jti`, `iat = now`). A fresh proof MUST be
 * built per request — proofs are not reusable (the server's replay guard consumes each `jti` once).
 */
export function buildDpopProof(key: DpopKeyPair, claims: DpopProofClaims, opts?: { readonly nowSec?: number }): string {
  const privateKey = createPrivateKey(key.privateKeyPem);
  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: randomUUID(),
    htm: claims.htm,
    htu: claims.htu,
    iat: now,
  };
  if (claims.accessToken !== undefined) {
    payload.ath = createHash('sha256').update(claims.accessToken, 'utf8').digest('base64url');
  }
  if (claims.nonce !== undefined) {
    payload.nonce = claims.nonce;
  }
  const h64 = base64url(Buffer.from(JSON.stringify(header)));
  const p64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${h64}.${p64}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}
