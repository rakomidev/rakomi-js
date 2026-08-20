/**
 * Passkey (WebAuthn) contracts — platform-neutral.
 *
 * The shapes here follow the **W3C WebAuthn Level 3 JSON forms**: camelCase members and
 * `Base64URLString` values (unpadded base64url, RFC 4648 §5). They are deliberately anchored to
 * the specification rather than to any WebAuthn library, so a browser binding and a native
 * binding can both satisfy them.
 *
 * Note the naming boundary: the REST envelopes this SDK speaks are snake_case
 * (`user_handle`, `step_up_token`), while the credential/options payloads carried *inside* those
 * envelopes are camelCase per the spec and are passed through verbatim.
 */

/** Unpadded base64url (RFC 4648 §5) — the WebAuthn JSON encoding for binary values. */
export type Base64URLString = string;

/**
 * A WebAuthn user handle.
 *
 * It is an **opaque, non-reversible** account identifier chosen by the server.
 * It MUST NOT carry personal data — never an email address, never a username,
 * never anything that identifies a natural person on its own. The WebAuthn specification is explicit
 * about this (L3 §14.6.1 privacy considerations), and a handle that carries personal data would be
 * stored on the authenticator, outside the server's control — a privacy-by-design failure under
 * art. 25 GDPR.
 *
 * The brand exists to make an accidental `email` argument a compile-time error.
 */
export type OpaqueUserHandle = Base64URLString & { readonly __opaqueUserHandle: unique symbol };

/** Cast a server-supplied handle to {@link OpaqueUserHandle}. The value MUST come from the server. */
export function asOpaqueUserHandle(value: Base64URLString): OpaqueUserHandle {
  return value as OpaqueUserHandle;
}

/**
 * Open unions: a future authenticator transport (or verification requirement) must NOT become a
 * type error in an already-released SDK, so unknown string values stay assignable.
 */
export type AuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'hybrid' | 'internal' | (string & {});
export type UserVerificationRequirement = 'required' | 'preferred' | 'discouraged' | (string & {});
export type AttestationConveyancePreference = 'none' | 'indirect' | 'direct' | 'enterprise' | (string & {});
export type AuthenticatorAttachment = 'platform' | 'cross-platform' | (string & {});
export type ResidentKeyRequirement = 'discouraged' | 'preferred' | 'required' | (string & {});

/** A credential descriptor as it appears in `allowCredentials` / `excludeCredentials`. */
export interface PublicKeyCredentialDescriptorJSON {
  id: Base64URLString;
  /** Always the literal `'public-key'` — the server sends it, the SDK never fabricates it. */
  type: 'public-key';
  transports?: AuthenticatorTransport[];
}

export interface AuthenticatorSelectionCriteria {
  authenticatorAttachment?: AuthenticatorAttachment;
  residentKey?: ResidentKeyRequirement;
  requireResidentKey?: boolean;
  userVerification?: UserVerificationRequirement;
}

/**
 * Registration options, exactly as the server sends them.
 *
 * Every field is server-driven. The SDK forwards this object **verbatim** to the ceremony adapter
 * and never fabricates, defaults, or relaxes a member — a client-side `userVerification` default
 * would silently downgrade an RP that demanded `'required'`, and the server cannot detect that.
 * The index signature is what lets a *newly added* server field survive the round-trip untouched.
 */
export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: Base64URLString; name: string; displayName: string };
  challenge: Base64URLString;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Assertion options, exactly as the server sends them. Same verbatim-passthrough contract. */
export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: Base64URLString;
  timeout?: number;
  rpId?: string;
  /** An EMPTY array is a normal usernameless case — never treat it as "no passkeys". */
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The authenticator's registration response, in W3C JSON form. Opaque to this SDK. */
export interface RegistrationResponseJSON {
  id: Base64URLString;
  rawId: Base64URLString;
  type: 'public-key';
  response: {
    clientDataJSON: Base64URLString;
    attestationObject: Base64URLString;
    transports?: AuthenticatorTransport[];
    [key: string]: unknown;
  };
  authenticatorAttachment?: AuthenticatorAttachment;
  clientExtensionResults?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The authenticator's assertion response, in W3C JSON form. Opaque to this SDK. */
export interface AuthenticationResponseJSON {
  id: Base64URLString;
  rawId: Base64URLString;
  type: 'public-key';
  response: {
    clientDataJSON: Base64URLString;
    authenticatorData: Base64URLString;
    signature: Base64URLString;
    userHandle?: Base64URLString;
    [key: string]: unknown;
  };
  authenticatorAttachment?: AuthenticatorAttachment;
  clientExtensionResults?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A registered passkey, as returned by the management endpoints. */
export interface PasskeySummary {
  id: string;
  nickname?: string;
  aaguid?: string;
  device_type: string;
  backed_up: boolean;
  backup_eligible: boolean;
  transports?: AuthenticatorTransport[];
  rp_id: string;
  last_used_at?: string;
  created_at: string;
}

/** Options every ceremony invocation receives. */
export interface PasskeyCeremonyOptions {
  /** Aborting this signal MUST abandon the ceremony. The core always supplies one. */
  signal?: AbortSignal;
}

/**
 * The seam between platform-neutral orchestration and the platform's WebAuthn call.
 *
 * `@rakomi/sdk-core` never touches `navigator.credentials`: it choreographs the REST ceremony and
 * delegates the authenticator interaction to an implementation of this interface. A browser binding
 * fulfils it with the WebAuthn JS API; a native binding fulfils it with the platform's passkey
 * module. One contract, two bindings — the same pattern the SDK already uses for HTTP and crypto.
 *
 * An implementation is treated as **untrusted**: it may be third-party code. Misbehaviour (a missing
 * method, a synchronous throw, a malformed return) is mapped to a typed error, never propagated.
 */
export interface PasskeyCeremonyAdapter {
  /**
   * Whether this platform can run a passkey ceremony **at all** — the base WebAuthn capability.
   *
   * It is deliberately NOT "is a user-verifying platform authenticator available". A user whose only
   * authenticator is a roaming security key holding a resident credential has a passkey by the FIDO
   * Alliance's own definition, so a binding that gated this on the platform-authenticator probe
   * would tell that user passkeys are unsupported. Whether a *platform* authenticator (Face ID,
   * Windows Hello) is present is a separate, optional UI hint a binding may expose alongside this —
   * never a gate, and never this method.
   *
   * A platform probe may be asynchronous, so the contract permits a Promise; a sync-only contract
   * would force a binding to return an optimistic `true` and defeat the short-circuit this exists
   * for. A throwing implementation is treated as **unsupported** (fail-closed).
   */
  isSupported(): boolean | Promise<boolean>;

  /** Run the registration ceremony. Reject per {@link PasskeyCeremonyError} on cancel/failure. */
  createCredential(
    options: PublicKeyCredentialCreationOptionsJSON,
    ceremonyOptions?: PasskeyCeremonyOptions,
  ): Promise<RegistrationResponseJSON>;

  /** Run the assertion ceremony. Reject per {@link PasskeyCeremonyError} on cancel/failure. */
  getCredential(
    options: PublicKeyCredentialRequestOptionsJSON,
    ceremonyOptions?: PasskeyCeremonyOptions,
  ): Promise<AuthenticationResponseJSON>;
}

/** The outcome kinds a binding can signal when a ceremony does not produce a credential. */
export type PasskeyCeremonyErrorKind = 'cancelled' | 'unsupported' | 'failed';

/**
 * The canonical, platform-neutral way for a binding to report a failed ceremony.
 *
 * A browser rejects with a `DOMException` (`NotAllowedError` / `AbortError`), which does not exist
 * on a native platform. Classifying on that name alone would silently misclassify every native
 * cancellation, so a native binding raises this instead and the core recognises **both** shapes.
 */
export class PasskeyCeremonyError extends Error {
  readonly kind: PasskeyCeremonyErrorKind;
  constructor(kind: PasskeyCeremonyErrorKind, message?: string) {
    super(message ?? `passkey ceremony ${kind}`);
    this.name = 'PasskeyCeremonyError';
    this.kind = kind;
  }
}

/**
 * What the caller should do next. Declarative metadata **in addition to** `code`, never a
 * replacement for it — so an integrator branches on an SDK-owned hint instead of re-deriving
 * control flow from a string.
 */
export type PasskeyNextAction = 'step-up' | 'retry' | 'backoff' | 'abort' | 'none';

/**
 * The CLOSED set of passkey failure codes. The boundaries between neighbours are load-bearing:
 * a cancel is "the user did nothing", a ceremony failure is "the authenticator refused", an adapter
 * error is "the integration is broken" — collapsing any pair destroys the caller's only signal.
 *
 * Every code is `PASSKEY_`-prefixed **on purpose**: `error.code` is a bare string, and a bare string
 * is what an application actually branches on once it leaves TypeScript — a log formatter, an
 * analytics tag, a `switch` written before this module existed. Sharing a code string with the SDK's
 * other error union while carrying a different field contract would make the same string mean two
 * things on one public surface. The namespaces are disjoint so that cannot happen.
 */
export type PasskeyErrorCode =
  /** The platform cannot do WebAuthn. Short-circuits before any network call. */
  | 'PASSKEY_NOT_SUPPORTED'
  /** The user dismissed the prompt, or the ceremony was aborted / timed out. */
  | 'PASSKEY_CEREMONY_CANCELLED'
  /** The authenticator refused (e.g. it already holds a credential for this user). */
  | 'PASSKEY_CEREMONY_FAILED'
  /** The injected adapter violated its contract. An integration bug, not a user outcome. */
  | 'PASSKEY_ADAPTER_ERROR'
  /** 401 `passkey/step_up_required` — obtain a step-up token and retry. */
  | 'PASSKEY_STEP_UP_REQUIRED'
  /** 409 on register-finish — this credential is already registered. */
  | 'PASSKEY_ALREADY_REGISTERED'
  /** The server rejected an already-completed ceremony (`ceremonyCompleted: true`). */
  | 'PASSKEY_FINISH_FAILED'
  /** A 200 whose `next_step` is not `'authenticated'` — tokens are withheld. */
  | 'PASSKEY_ADDITIONAL_STEP_REQUIRED'
  /** 429 — back off (see `retryAfterMs`, present only when the server sent `Retry-After`). */
  | 'PASSKEY_RATE_LIMITED'
  /** 403 — the account is blocked. Terminal. */
  | 'PASSKEY_BLOCKED'
  /** 404 with the feature-flag code — passkeys are off for this tenant. Terminal. */
  | 'PASSKEY_DISABLED'
  /** 404 on a management call — cross-tenant, or not owned by this user. Terminal. */
  | 'PASSKEY_NOT_FOUND'
  /** 409 on delete — this is the user's last sign-in method. */
  | 'PASSKEY_LAST_METHOD'
  /** A client-side guard tripped (e.g. nickname length). Rejected locally, zero network calls. */
  | 'PASSKEY_INVALID_INPUT'
  /** The credential itself can never work again here (RP-ID mismatch, unknown/revoked credential). */
  | 'PASSKEY_CREDENTIAL_UNUSABLE'
  /** The assertion was rejected — a different passkey (or another sign-in method) may still work. */
  | 'PASSKEY_SIGN_IN_FAILED'
  /** A 401 that is NOT a step-up demand — the access token is expired or invalid. */
  | 'PASSKEY_SESSION_EXPIRED'
  /** Anything else the server refused, on any surface other than sign-in. */
  | 'PASSKEY_REQUEST_FAILED'
  /** The request never reached the server. */
  | 'PASSKEY_NETWORK_ERROR';

/**
 * The reused step-up identity, as plain data.
 *
 * `MFA_STEP_UP_UNAVAILABLE` is the SAME identity the SDK's existing step-up taxonomy uses
 * (`oauth/mfa.ts`) — the passkey leg partitions the same space as TOTP rather than growing a second,
 * parallel vocabulary for the same condition.
 */
export interface PasskeyErrorCause {
  code: 'MFA_STEP_UP_UNAVAILABLE';
  /** Server-supplied guidance — surface it to the user verbatim. */
  guidance: string;
}

/**
 * A passkey failure. Never thrown — always returned inside `{ ok: false, error }`.
 *
 * It carries no secret: no step-up token, no access/refresh token, no server challenge, no raw
 * credential bytes. Host applications log error objects, so a leaked challenge or step-up token
 * would be a replay primitive.
 */
export interface PasskeyError {
  code: PasskeyErrorCode;
  message: string;
  nextAction: PasskeyNextAction;
  /** Present only when the server sent a parseable `Retry-After`. Never a fabricated default. */
  retryAfterMs?: number;
  /** The unexpected `next_step` value, when `code` is `PASSKEY_ADDITIONAL_STEP_REQUIRED`. */
  nextStep?: string;
  /**
   * The step-up leg reuses the SDK's existing step-up taxonomy rather than inventing a parallel one:
   * "this user has no passkey to step up with" carries the same `MFA_STEP_UP_UNAVAILABLE` identity
   * and the server's guidance text (which is meant to be shown to the user verbatim).
   *
   * It is **plain data, not an `Error` instance**. An Error inside a result object survives neither
   * `JSON.stringify` (a message is non-enumerable — it silently vanishes) nor `structuredClone`
   * (the subclass is downgraded to a bare `Error` and its own fields are dropped), and this result
   * is exactly the kind of value applications put through a state store, a worker boundary, or an
   * offline queue. The identity is reused; neither the throwing convention nor the class is.
   */
  cause?: PasskeyErrorCause;
}

/** Tokens returned by a successful assertion, mirroring the SDK's existing token bundle. */
export interface PasskeyTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export type RegisterPasskeyResult =
  | { ok: true; passkeyId: string }
  /** `ceremonyCompleted` is true when the authenticator already minted a credential the server then rejected. */
  | { ok: false; error: PasskeyError; ceremonyCompleted?: boolean };

export type AssertPasskeyResult =
  | { ok: true; tokens: PasskeyTokens }
  | { ok: false; error: PasskeyError };

export type StepUpWithPasskeyResult =
  | { ok: true; stepUpToken: string; tokenType: 'StepUp'; expiresIn: number }
  | { ok: false; error: PasskeyError };

export type ListPasskeysResult =
  | { ok: true; data: PasskeySummary[] }
  | { ok: false; error: PasskeyError };

export type PasskeySummaryResult =
  | { ok: true; passkey: PasskeySummary }
  | { ok: false; error: PasskeyError };

export type DeletePasskeyResult =
  | { ok: true }
  | { ok: false; error: PasskeyError };
