
import { createDpopProver, type DpopProver } from './dpop.js';

/** Reason a DPoP-requested session was downgraded to Bearer by the server. */
export interface DpopDowngradeInfo {
  /** The server returned `token_type: "Bearer"` for a session that presented a DPoP proof. */
  reason: 'server_returned_bearer';
}

/** Options for {@link createDpopSession} / the {@link DpopSession} constructor. */
export interface CreateDpopSessionOptions {
  /**
   * Base URL of the Rakomi API (e.g. `https://api.rakomi.com`). Used to build
   * the canonical `htu` of the DPoP proof. MUST match the host the refresh call
   * targets, or the server rejects the proof (`htu` mismatch, RFC 9449 §4.3).
   */
  baseUrl: string;
  /**
   * Pinned proof algorithm. Defaults to `ES256` — the cross-port baseline
   * (universally available; Apple Secure-Enclave-eligible). `EdDSA` is
   * `@rakomi/node`-only. The `alg` is NEVER derived from a key or any input.
   */
  alg?: 'ES256' | 'EdDSA';
  /**
   * Invoked at most once if the server downgrades a DPoP-requested session to
   * `Bearer` (security-downgrade detector). The session does NOT become bound.
   * No secret material (proof / key / jwk / jti) is ever passed to this hook.
   */
  onDowngrade?: (info: DpopDowngradeInfo) => void;
}

/**
 * Opaque, session-scoped DPoP binding handle. Create ONE per logged-in session,
 * pass it to `exchangeCode({..., dpop })` AND every `refreshToken({..., dpop })`
 * for that session. Never share an instance across distinct sessions or across
 * a refresh token boundary.
 *
 * @public — additive-only after the first public release (a removed/renamed member
 * is a MAJOR bump). The options-bag shape leaves room for a future rotation hook
 * to be appended additively.
 */
export class DpopSession {
  private prover: DpopProver;
  private readonly onDowngrade?: (info: DpopDowngradeInfo) => void;
  private readonly baseUrl: string;
  private readonly alg: 'ES256' | 'EdDSA' | undefined;
  private _bound = false;
  private _downgraded = false;
  private _downgradeNotified = false;
  private _boundJkt: string | undefined;
  private _inflightRotation: Promise<unknown> | null = null;

  constructor(options: CreateDpopSessionOptions) {
    this.baseUrl = options.baseUrl;
    this.alg = options.alg;
    this.prover = createDpopProver({
      baseUrl: options.baseUrl,
      ...(options.alg !== undefined ? { alg: options.alg } : {}),
    });
    this.onDowngrade = options.onDowngrade;
  }

  /**
   * `true` once the server has confirmed (`token_type === "DPoP"`) that this
   * session's key is sender-bound. The SDK attaches a refresh proof IFF this is
   * `true`. Starts `false`; set by observing issuance/refresh responses.
   */
  get isBound(): boolean {
    return this._bound;
  }

  /**
   * `true` if a session that presented a DPoP proof was returned as `Bearer` by
   * the server (a security downgrade — flag off / server-side downgrade). The
   * session is NOT bound in this state and attaches no further proofs.
   */
  get isDowngraded(): boolean {
    return this._downgraded;
  }

  /**
   * The committed RFC 7638 thumbprint (`jkt`) of the session keypair, available
   * once the session is bound. Lets the SDK cross-check that the bound
   * thumbprint matches the refresh-time key (a `jkt`-continuity self-check).
   */
  get boundJkt(): string | undefined {
    return this._boundJkt;
  }

  async resolveProof(htm: string, path: string, opts?: { nonce?: string }): Promise<string> {
    return this.prover.proof(htm, path, opts);
  }

  async jktHint(): Promise<string> {
    return this.prover.jktHint();
  }

  async resolveRotationProofs(
    htm: string,
    path: string,
    opts?: { nonce?: string; incoming?: DpopProver },
  ): Promise<{ oldProof: string; newProof: string; incoming: DpopProver; newJkt: string }> {
    const incoming =
      opts?.incoming ??
      createDpopProver({
        baseUrl: this.baseUrl,
        ...(this.alg !== undefined ? { alg: this.alg } : {}),
      });
    const proofOpts = opts?.nonce !== undefined ? { nonce: opts.nonce } : undefined;
    const [oldProof, newProof, newJkt] = await Promise.all([
      this.prover.proof(htm, path, proofOpts),
      incoming.proof(htm, path, proofOpts),
      incoming.jktHint(),
    ]);
    return { oldProof, newProof, incoming, newJkt };
  }

  async commitRotation(incoming: DpopProver): Promise<boolean> {
    const outgoingJkt = await this.prover.jktHint();
    if (this._boundJkt !== undefined && this._boundJkt !== outgoingJkt) {
      return false;
    }
    const incomingJkt = await incoming.jktHint();
    this.prover = incoming;
    this._bound = true;
    this._downgraded = false;
    this._boundJkt = incomingJkt;
    return true;
  }

  async runExclusiveRotation<T>(fn: () => Promise<T>): Promise<T> {
    if (this._inflightRotation !== null) {
      return this._inflightRotation as Promise<T>;
    }
    const promise = fn();
    this._inflightRotation = promise;
    try {
      return await promise;
    } finally {
      this._inflightRotation = null;
    }
  }

  async observeTokenType(tokenType: string | undefined, attachedProof: boolean): Promise<void> {
    if (tokenType === 'DPoP') {
      this._bound = true;
      this._downgraded = false;
      if (this._boundJkt === undefined) {
        this._boundJkt = await this.prover.jktHint();
      }
      return;
    }
    this._bound = false;
    if (attachedProof) {
      this._downgraded = true;
      if (!this._downgradeNotified) {
        this._downgradeNotified = true;
        this.onDowngrade?.({ reason: 'server_returned_bearer' });
      }
    }
  }
}

/**
 * Factory for a {@link DpopSession}. Equivalent to `new DpopSession(options)` —
 * provided for parity with the functional `createDpopProver` API.
 *
 * @public — additive-only after the first public release.
 */
export function createDpopSession(options: CreateDpopSessionOptions): DpopSession {
  return new DpopSession(options);
}
