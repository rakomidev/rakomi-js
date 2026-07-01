
import type { DpopProofInput, DpopProver } from './types.js';

/**
 * The raw native-module surface a RN host exposes for DPoP signing — a
 * TurboModule / legacy NativeModule whose methods take POSITIONAL arguments and
 * return Promises (RN bridge convention: no `undefined` across the bridge — an
 * absent nonce is passed as `null`).
 *
 * contract the native implementation MUST honour:
 * - Generate ONE session keypair in the secure element on first use and hold it
 * for the module instance's lifetime (one keypair per session); NEVER
 * regenerate per call (a fresh key ⇒ `jkt` mismatch ⇒ 401 on every refresh).
 * - `createDpopProof` builds + signs the FULL compact proof JWT natively and
 * resolves the `DPoP` header value; it owns `jti`/`iat`/`typ`/`jwk`/`alg`.
 * - Reject (Promise rejection) when the secure element is unavailable — NEVER
 * resolve an empty string or a Bearer-shaped placeholder.
 */
export interface NativeDpopModuleSpec {
  /**
   * Build + sign the compact DPoP-proof JWT in the secure element for the bound
   * request. `nonce` is `null` unless this is the RFC 9449 §8 nonce retry.
   * Resolves the `DPoP` header value.
   */
  createDpopProof(htm: string, htu: string, nonce: string | null): Promise<string>;
  /** RFC 7638 SHA-256 thumbprint of the session public key (stable for the key's life). */
  dpopJktThumbprint(): Promise<string>;
}

export interface CreateNativeDpopProverOptions {
  /**
 * The host's native DPoP module. On bare RN this is the linked native module
 * (`NativeModules.RakomiDpop`); on Expo it is the Expo module's JS surface.
 * The module MUST be backed by the platform secure element.
 */
  module: NativeDpopModuleSpec;
}

/**
 * Adapt a host's native DPoP signing module to the canonical {@link DpopProver}
 * contract. Wire the result into the consumer's `NativeAuthAdapter.dpopProver`
 * slot; `<RakomiProvider>` then auto-constructs the session-scoped `DpopSession`.
 *
 * The adapter enforces the no-silent-downgrade invariant: if the native
 * signer rejects OR returns a falsy proof, `createProof` throws so the refresh
 * path surfaces `auth/dpop_prover_unavailable` and makes NO proof-less network
 * call — it never falls back to an empty/Bearer request.
 *
 * @public — additive-only.
 */
export function createNativeDpopProver(options: CreateNativeDpopProverOptions): DpopProver {
  const mod = options.module;
  return {
    async createProof(input: DpopProofInput): Promise<string> {
      const proof = await mod.createDpopProof(input.htm, input.htu, input.nonce ?? null);
      if (typeof proof !== 'string' || proof.length === 0) {
        throw new Error('native DPoP signer returned an empty proof');
      }
      return proof;
    },
    async jktHint(): Promise<string> {
      return mod.dpopJktThumbprint();
    },
  };
}
