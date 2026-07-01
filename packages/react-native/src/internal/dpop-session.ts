
import type { DpopProver } from '../native/types.js';
import { canonicalizeUrl } from './canonical-url.js';

/** Reason a DPoP-requested session was downgraded to Bearer by the server. */
export interface DpopDowngradeInfo {
  /** The server returned `token_type: "Bearer"` for a session that presented a DPoP proof. */
  reason: 'server_returned_bearer';
}

export interface CreateDpopSessionOptions {
  /**
   * The native-keystore-backed prover for this session (one keypair per session).
   * Wire the consumer's native adapter (`NativeAuthAdapter.dpopProver`) here. The
   * SAME instance MUST serve issuance and refresh — never construct a new prover
   * per refresh.
   */
  prover: DpopProver;
  /**
   * Base URL of the Rakomi API (e.g. `https://api.rakomi.com`). Used to build the
   * canonical `htu` of the proof; MUST match the host the refresh call targets or
   * the server rejects the proof (`htu` mismatch, RFC 9449 §4.3).
   */
  baseUrl: string;
  /**
   * Invoked at most once if the server downgrades a DPoP-requested session to
   * `Bearer`. The session does NOT become bound. No secret material (proof / key
   * / jwk / jti) is ever passed to this hook.
   */
  onDowngrade?: (info: DpopDowngradeInfo) => void;
}

/**
 * Opaque, session-scoped DPoP binding handle. Create ONE per logged-in session,
 * pass it to the auth ceremony AND every refresh for that session. Never share an
 * instance across distinct sessions or across a refresh-token boundary.
 *
 * @public — additive-only.
 */
export class DpopSession {
  private readonly prover: DpopProver;
  private readonly baseUrl: string;
  private readonly onDowngrade?: (info: DpopDowngradeInfo) => void;
  private _bound = false;
  private _downgraded = false;
  private _downgradeNotified = false;
  private _boundJkt: string | undefined;

  constructor(options: CreateDpopSessionOptions) {
    this.prover = options.prover;
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
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
   * the server (a security downgrade — flag off / server-side downgrade).
   */
  get isDowngraded(): boolean {
    return this._downgraded;
  }

  /** The committed RFC 7638 thumbprint (`jkt`) of the session keypair, once bound. */
  get boundJkt(): string | undefined {
    return this._boundJkt;
  }

  async resolveProof(htm: string, target: string, opts?: { nonce?: string }): Promise<string> {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `${this.baseUrl}${target}`;
    const htu = canonicalizeUrl(absolute);
    const input = { htm, htu, ...(opts?.nonce !== undefined ? { nonce: opts.nonce } : {}) };
    return this.prover.createProof(input);
  }

  async jktHint(): Promise<string> {
    return this.prover.jktHint();
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
 * Factory for a {@link DpopSession}. Equivalent to `new DpopSession(options)`.
 *
 * @public — additive-only.
 */
export function createDpopSession(options: CreateDpopSessionOptions): DpopSession {
  return new DpopSession(options);
}
