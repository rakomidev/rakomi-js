
import { createHash, randomUUID } from 'node:crypto';

import type { JWK } from 'jose';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';

import { canonicalizeUrl } from './internal/canonical-url.js';
type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const DPOP_PROOF_ALLOWED_ALGS = ['ES256', 'EdDSA'] as const;
type DpopProofAlg = (typeof DPOP_PROOF_ALLOWED_ALGS)[number];

export interface DpopProver {
  /**
   * Build a DPoP-proof JWT for `htm` + `path`. Resolves to the compact-
   * serialized proof string to set on the `DPoP` HTTP header. When
   * `accessToken` is provided, adds the `ath` claim (RFC 9449 §4.3 — REQUIRED
   * on resource-server calls). `nonce` is optional (RFC 9449 §8 nonce
   * challenge response). The proof is signed with the SDK instance's
   * ephemeral keypair (generated lazily on first call).
   */
  proof(htm: string, path: string, options?: { accessToken?: string; nonce?: string }): Promise<string>;
  /** SHA-256 thumbprint of the ephemeral public JWK (RFC 7638). */
  jktHint(): Promise<string>;
}

interface ProverState {
  privateKey: KeyLike;
  publicJwk: JWK;
  alg: DpopProofAlg;
  jkt: string;
}

export interface CreateDpopProverOptions {
  baseUrl: string;
  alg?: DpopProofAlg;
}

export function createDpopProver(options: CreateDpopProverOptions): DpopProver {
  const alg = options.alg ?? DPOP_PROOF_ALLOWED_ALGS[0];
  const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
  let statePromise: Promise<ProverState> | null = null;

  async function getState(): Promise<ProverState> {
    if (!statePromise) {
      statePromise = (async () => {
        const { privateKey, publicKey } = await generateKeyPair(alg, {
          ...(alg === 'EdDSA' ? { crv: 'Ed25519' as const } : {}),
          extractable: false,
        });
        const publicJwk = await exportJWK(publicKey);
        const jkt = await calculateJwkThumbprint(publicJwk, 'sha256');
        return { privateKey, publicJwk, alg, jkt };
      })();
    }
    return statePromise;
  }

  return {
    async proof(htm, path, opts) {
      const state = await getState();
      const sanitizedPath = path.split('?')[0]!.split('#')[0]!;
      const htu = canonicalizeUrl(`${baseUrl}${sanitizedPath}`);
      const payload: Record<string, unknown> = {
        htm,
        htu,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ...(opts?.accessToken !== undefined && {
          ath: createHash('sha256').update(opts.accessToken, 'utf8').digest('base64url'),
        }),
        ...(opts?.nonce !== undefined && { nonce: opts.nonce }),
      };
      return new SignJWT(payload)
        .setProtectedHeader({
          typ: 'dpop+jwt',
          alg: state.alg,
          jwk: state.publicJwk,
        })
        .sign(state.privateKey);
    },
    async jktHint() {
      const state = await getState();
      return state.jkt;
    },
  };
}
