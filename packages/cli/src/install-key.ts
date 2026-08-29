// SPDX-License-Identifier: MIT

import { createPrivateKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

import { isCimdClientId } from './env.js';
import { type HttpDeps, request } from './http.js';
import type { KeyStore, StoredSession } from './session.js';

const INSTALL_KEY_NAME = 'install-key';

/** RFC 7523 §3 client-assertion lifetime — comfortably under the server's floor
 * (`CIMD_CLIENT_ASSERTION_MAX_LIFETIME_SEC`, min 30s, default 120s) and the shared
 * `CLIENT_ASSERTION_MAX_LIFETIME_SEC` (120s) both bound against. */
const ASSERTION_LIFETIME_SEC = 60;

export interface StoredInstallKey {
  readonly clientId: string;
  readonly privateKeyPem: string;
  readonly publicJwk: Record<string, unknown>;
  /** `true` IFF a PRIOR `bindInstallKey()` call confirmed THIS key is the one bound on the server's row. */
  readonly confirmedBound: boolean;
}

function isStoredInstallKey(v: unknown): v is StoredInstallKey {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.clientId === 'string' &&
    typeof r.privateKeyPem === 'string' &&
    typeof r.publicJwk === 'object' &&
    r.publicJwk !== null &&
    typeof r.confirmedBound === 'boolean'
  );
}

function generateKeyPair(clientId: string): StoredInstallKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { clientId, privateKeyPem, publicJwk, confirmedBound: false };
}

/** Read the install keypair for `clientId` from `keys`, generating and persisting a fresh one if
 * absent, corrupted, or bound to a DIFFERENT `clientId` (e.g. `RAKOMI_CLIENT_ID` changed — the old
 * key's confirmation, if any, does not carry over to an unrelated client identity). */
export function getOrCreateInstallKey(keys: KeyStore, clientId: string): StoredInstallKey {
  const raw = keys.get(INSTALL_KEY_NAME);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredInstallKey(parsed) && parsed.clientId === clientId) return parsed;
    } catch {
    }
  }
  const fresh = generateKeyPair(clientId);
  keys.set(INSTALL_KEY_NAME, JSON.stringify(fresh));
  return fresh;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * RFC 7523 §2.2 `private_key_jwt` client-assertion, signed with the install's OWN local key.
 * `iss === sub === clientId` (the CIMD URL); `aud` is the token endpoint's own audience. Every field
 * mirrors what `client-assertion.ts`'s `verifyClientAssertion` requires server-side — this is a
 * from-scratch compact-JWS builder, not a copy of any server code (the CLI ships zero runtime deps).
 */
export function signClientAssertion(
  key: StoredInstallKey,
  opts: { readonly clientId: string; readonly audience: string; readonly nowSec?: number },
): string {
  const privateKey = createPrivateKey(key.privateKeyPem);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = {
    iss: opts.clientId,
    sub: opts.clientId,
    aud: opts.audience,
    jti: randomUUID(),
    iat: now,
    exp: now + ASSERTION_LIFETIME_SEC,
  };
  const h64 = base64url(Buffer.from(JSON.stringify(header)));
  const p64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${h64}.${p64}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

export interface BindInstallKeyResult {
  readonly attempted: boolean;
  readonly bound: boolean;
}

/**
 * Best-effort: submit `key.publicJwk` to the server's TOFU bind endpoint and persist the outcome.
 * NEVER throws — a network hiccup, a server that does not yet have this route deployed (rolling
 * upgrade), or any other failure degrades to `{ attempted: false, bound: false }` and the CLI
 * proceeds exactly as it did before this story (PKCE-only `rakomi login`). Idempotent: calling this
 * again after a CONFIRMED bind is a cheap no-op read-through (the server-side TOFU check is itself
 * idempotent), so callers do not need to remember whether they already bound.
 *
 * `opts.dpopBound` — `true` IFF the access token this call is
 * authenticating with was itself minted `token_type:'DPoP'` (the login that just happened sent a DPoP
 * proof and the server bound it). When true, this call MUST also present a DPoP proof from the SAME
 * key — a DPoP-bound token requires proof-of-possession on every authenticated request, resource
 * routes included.
 */
export async function bindInstallKey(
  deps: HttpDeps,
  keys: KeyStore,
  opts: { readonly apiBaseUrl: string; readonly clientId: string; readonly accessToken: string; readonly dpopBound?: boolean },
  key: StoredInstallKey,
): Promise<BindInstallKeyResult> {
  try {
    const result = await request<{ bound: boolean }>(deps, {
      method: 'POST',
      url: `${opts.apiBaseUrl}/v1/oauth-clients/install-key`,
      headers: opts.dpopBound ? undefined : { authorization: `Bearer ${opts.accessToken}` },
      body: { client_id: opts.clientId, jwk: key.publicJwk },
      dpop: opts.dpopBound ? { key, accessToken: opts.accessToken } : undefined,
    });
    if (result.status !== 200) return { attempted: true, bound: false };
    const bound = result.body.bound === true;
    if (bound !== key.confirmedBound) {
      keys.set(INSTALL_KEY_NAME, JSON.stringify({ ...key, confirmedBound: bound }));
    }
    return { attempted: true, bound };
  } catch {
    return { attempted: false, bound: false };
  }
}

/**
 * The install key to use for DPoP proof-of-possession on an AUTHENTICATED call, or `undefined` when
 * this session cannot get one — an ordinary `Bearer` session, a non-CIMD `--client` (DPoP is only
 * ever active for the CLI's own first-party CIMD identity — `dpop_mode` stays `'off'` for every
 * other materialized client server-side), OR a `token_type:'DPoP'` session whose `client_id` is NOT
 * a CIMD URL. Reads the SAME `KeyStore` entry `getOrCreateInstallKey()` already generated/loaded at
 * login (keyed by `session.client_id`) — never a fresh key, or the server's `cnf.jkt` binding would
 * not match.
 *
 * **Disclosed scope boundary — `rakomi login --ci` sessions.** That flow's `client_id` is the
 * sentinel `'oidc-federation'` (not a CIMD URL), so `isCimdClientId` is false and this function
 * correctly returns `undefined` even though the session genuinely IS `token_type:'DPoP'` — the CI
 * flow's DPoP key is deliberately EPHEMERAL and in-memory-only (`dpop.ts`'s
 * `generateEphemeralDpopKey`, never persisted to any `KeyStore`), so there is no durable key here to
 * resolve, by design (a CI runner must not leave key material on disk). The practical
 * consequence — a subsequent authenticated CLI call in the SAME job falls back to `Authorization:
 * Bearer`, which the server's `cnf.jkt`-bound-token check rejects — is a REAL, PRE-EXISTING gap this
 * function does not close and must not silently paper over by attempting to persist the ephemeral
 * key; that would be a security-relevant design change (whether/how to give a CI job's key
 * job-lifetime persistence) this function does not make unilaterally. Tracked:
 * A tracked follow-up covers per-request DPoP wiring for CI sessions.
 */
export function resolveDpopKey(keys: KeyStore, session: StoredSession): StoredInstallKey | undefined {
  if (session.token_type !== 'DPoP') return undefined;
  if (!isCimdClientId(session.client_id)) return undefined;
  return getOrCreateInstallKey(keys, session.client_id);
}
