import type { SdkError } from './types.js';

const DOCS_BASE = 'https://docs.rakomi.dev/sdk/errors';

/**
 * Error class thrown by Rakomi constructor for configuration errors.
 * Extends Error so `instanceof Error` works and stack traces are available.
 */
export class RakomiError extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly docs_url: string;
  readonly fix_command?: string;

  constructor(sdkError: SdkError) {
    super(sdkError.message);
    this.name = 'RakomiError';
    this.code = sdkError.code;
    this.suggestion = sdkError.suggestion;
    this.docs_url = sdkError.docs_url;
    this.fix_command = sdkError.fix_command;
  }
}

function createError(
  code: string,
  message: string,
  suggestion: string,
  fix_command?: string,
): SdkError {
  return {
    code,
    message,
    suggestion,
    docs_url: `${DOCS_BASE}#${code.replace('/', '-')}`,
    fix_command,
  };
}

export const ERROR_CODES = {
  TOKEN_REVOKED: 'token/revoked',
  TOKEN_EXPIRED: 'token/expired',
  TOKEN_INVALID_SIGNATURE: 'token/invalid_signature',
  TOKEN_MALFORMED: 'token/malformed',
  TOKEN_INVALID_ALGORITHM: 'token/invalid_algorithm',
  TOKEN_MISSING_CLAIMS: 'token/missing_claims',
  TOKEN_INVALID_ISSUER: 'token/invalid_issuer',
  TOKEN_INVALID_AUDIENCE: 'token/invalid_audience',
  TOKEN_NOT_YET_VALID: 'token/not_yet_valid',
  AUTH_ENVIRONMENT_MISMATCH: 'auth/environment_mismatch',
  AUTH_DPOP_PROVER_UNAVAILABLE: 'auth/dpop_prover_unavailable',
  AUTH_INVALID_DPOP_PROOF: 'auth/invalid_dpop_proof',
  AUTH_INVALID_REFRESH_TOKEN: 'auth/invalid_refresh_token',
  AUTH_DPOP_ROTATION_NOOP: 'auth/dpop_rotation_noop',
  AUTH_DPOP_ROTATION_DID_NOT_TAKE: 'auth/dpop_rotation_did_not_take',
  AUTH_REFRESH_SUPERSEDED_BY_ROTATION: 'auth/refresh_superseded_by_rotation',
  JWKS_FETCH_FAILED: 'jwks/fetch_failed',
  JWKS_NO_MATCHING_KEY: 'jwks/no_matching_key',
  JWKS_INVALID_RESPONSE: 'jwks/invalid_response',
  WEBHOOK_TIMESTAMP_TOO_OLD: 'webhook/timestamp_too_old',
  WEBHOOK_TIMESTAMP_TOO_NEW: 'webhook/timestamp_too_new',
  WEBHOOK_INVALID_SIGNATURE: 'webhook/invalid_signature',
  WEBHOOK_INVALID_SECRET: 'webhook/invalid_secret',
  WEBHOOK_MISSING_HEADER: 'webhook/missing_header',
  WEBHOOK_INVALID_BODY: 'webhook/invalid_body',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const TOKEN_REVOKED = () =>
  createError(
    'token/revoked',
    'Token was issued before emergency revocation',
    'Re-authenticate the user. All sessions were invalidated by platform operator.',
  );

export const TOKEN_EXPIRED = () =>
  createError(
    'token/expired',
    'Token has expired',
    'Request a new access token via refresh token endpoint',
  );

export const TOKEN_INVALID_SIGNATURE = () =>
  createError(
    'token/invalid_signature',
    'Token signature verification failed',
    'Ensure the token was issued by Rakomi and has not been tampered with',
  );

export const TOKEN_MALFORMED = () =>
  createError(
    'token/malformed',
    'Token is not a valid JWT format',
    'Ensure you are passing a complete JWT string (header.payload.signature)',
  );

export const TOKEN_INVALID_ALGORITHM = () =>
  createError(
    'token/invalid_algorithm',
    'Unsupported algorithm. Only RS256 is allowed',
    'Rakomi tokens use RS256. Do not attempt to use HS256 or other algorithms',
  );

export const TOKEN_MISSING_CLAIMS = () =>
  createError(
    'token/missing_claims',
    'Required claims missing (sub, tenant_id, email, sid, iss, aud, exp, iat, jti)',
    'Ensure the token was issued by Rakomi login/refresh endpoints',
  );

export const TOKEN_INVALID_ISSUER = () =>
  createError(
    'token/invalid_issuer',
    'Token issuer mismatch',
    'Token must be issued by rakomi.com. Verify you are using the correct environment',
  );

export const TOKEN_INVALID_AUDIENCE = () =>
  createError(
    'token/invalid_audience',
    'Token audience mismatch',
    'Ensure the token was issued for this Rakomi deployment. Tokens from other Rakomi instances cannot be reused here.',
  );

export const TOKEN_NOT_YET_VALID = () =>
  createError(
    'token/not_yet_valid',
    'Token nbf (not before) is in the future',
    'Check system clock synchronization or increase clockTolerance in SDK config',
    'new Rakomi({ apiKey: "...", clockTolerance: 60 })',
  );

export const AUTH_ENVIRONMENT_MISMATCH = () =>
  createError(
    'auth/environment_mismatch',
    'Token environment does not match SDK environment. A test token cannot be verified with a live API key (and vice versa).',
    'Ensure the API key and token are from the same environment (both live or both test).',
  );

/**
 * Client-side: this SDK/platform could not produce a DPoP proof here (no native
 * prover, or the signer threw / returned falsy). NOT a security event — the SDK
 * deliberately refused to send an empty/malformed `DPoP` header rather than
 * silently downgrade to Bearer. App action: report a bug / re-login.
 */
export const AUTH_DPOP_PROVER_UNAVAILABLE = (detail?: string) =>
  createError(
    'auth/dpop_prover_unavailable',
    detail || 'No DPoP prover is available to sign the refresh proof on this platform',
    'Report this as a bug or re-authenticate the user. The SDK refused to send a malformed or empty DPoP proof — it did NOT silently downgrade to Bearer.',
  );

/**
 * Server rejected the DPoP proof on the refresh request (signature / `htu` /
 * `htm` / replayed `jti` / cold-start key mismatch). App action: re-attach a
 * fresh proof, check device clock skew, or re-authenticate to re-bind the key.
 */
export const AUTH_INVALID_DPOP_PROOF = (detail?: string) =>
  createError(
    'auth/invalid_dpop_proof',
    detail || 'The server rejected the DPoP proof on the refresh request',
    'Re-attach a fresh proof and check device clock skew. After an app/process restart the in-memory key is lost — re-authenticate to re-bind a fresh session key.',
  );

/**
 * The refresh token itself is invalid, expired, or has been revoked (the
 * genuine end-of-session class — RFC 6749 `invalid_grant` on the refresh
 * operation). App action: start a full re-authentication (login) flow.
 */
export const AUTH_INVALID_REFRESH_TOKEN = (detail?: string) =>
  createError(
    'auth/invalid_refresh_token',
    detail || 'The refresh token is invalid, expired, or has been revoked',
    'The session has ended. Start a full re-authentication (login) flow.',
  );

/**
 * Client-side rotation bug: the SDK attempted to rotate to a key the server
 * already has bound (server `400 invalid_request` reason `rotation_noop`). NOT a
 * security event and NO re-login — the session is unchanged. A fresh keypair
 * makes this practically unreachable from the SDK; it surfaces only if a caller
 * forces the new key to equal the old. App action: drop the rotation, keep using
 * the current session.
 */
export const AUTH_DPOP_ROTATION_NOOP = (detail?: string) =>
  createError(
    'auth/dpop_rotation_noop',
    detail || 'Rotation to the currently-bound key is a no-op',
    'Do not rotate to the current key. The session binding is unchanged — keep using the existing session.',
  );

/**
 * The rotation did not take AND no usable refreshed token was obtained. This is the
 * FAILURE arm — distinct from the common rotation-unaware-server case where the
 * refresh itself succeeds (that returns `{ ok: true, data: { ...tokens, rotated: false } }` — a
 * {@link RotationTokenResponse} the caller MUST persist). This error fires
 * only when there is nothing to persist:
 *   - a rotation that lost the token-keyed gate to a concurrent ordinary refresh of
 *     the same one-time-use token (fail-SAFE, NO network call, OLD key still bound);
 *   - the unreachable-by-construction local pre-swap invariant refusing a swap the
 *     server DID confirm (a new-key-bound token the SDK has no prover for).
 * The OLD key is STILL bound (never a half-swap). App action: retry the rotation, or
 * re-authenticate if it keeps not taking.
 */
export const AUTH_DPOP_ROTATION_DID_NOT_TAKE = (detail?: string) =>
  createError(
    'auth/dpop_rotation_did_not_take',
    detail || 'The server did not apply the key rotation (the old key is still bound)',
    'The rotation did not take — the old key is still bound (no half-swap). Retry the rotation, or re-authenticate if it keeps failing.',
  );

/**
 * A refresh and a key-rotation were attempted concurrently on the SAME
 * refresh_token. The server one-time-uses + rotates the refresh token on
 * every success, so the two operations can never both spend the same token value
 * without tripping server refresh-reuse detection (which revokes ALL session
 * tokens). The SDK serializes every refresh_token-consuming operation through one
 * token-keyed choke point: a key rotation already owns this token, so THIS
 * ordinary refresh was NOT sent (fail-SAFE — no network call, no double-spend).
 * The session/binding are unchanged. App action: use the rotation's result (it
 * also delivers fresh tokens), or retry the refresh with the rotated
 * refresh_token once the rotation settles.
 */
export const AUTH_REFRESH_SUPERSEDED_BY_ROTATION = (detail?: string) =>
  createError(
    'auth/refresh_superseded_by_rotation',
    detail || 'A concurrent key rotation is consuming this refresh token; the refresh was not sent',
    'A key rotation is consuming this refresh token. Use the rotation result, or retry the refresh with the rotated refresh token after the rotation settles.',
  );

export const JWKS_FETCH_FAILED = (detail?: string) =>
  createError(
    'jwks/fetch_failed',
    `Failed to fetch JWKS${detail ? `: ${detail}` : ''}`,
    'Check network connectivity and that baseUrl is correct',
    'curl https://api.rakomi.com/.well-known/jwks.json',
  );

export const JWKS_NO_MATCHING_KEY = () =>
  createError(
    'jwks/no_matching_key',
    'No key in JWKS matches token kid',
    'The signing key may have been rotated. This is transient during key rotation — retry in a few seconds',
  );

export const JWKS_INVALID_RESPONSE = () =>
  createError(
    'jwks/invalid_response',
    'JWKS response is not a valid JSON Web Key Set',
    'Ensure baseUrl points to a valid Rakomi instance',
  );

export const WEBHOOK_TIMESTAMP_TOO_OLD = (tolerance: number) =>
  createError(
    'webhook/timestamp_too_old',
    `Webhook timestamp is too old — exceeds ${tolerance}s tolerance`,
    'Ensure your server clock is synchronized. The webhook may be a replay attack',
  );

export const WEBHOOK_TIMESTAMP_TOO_NEW = (tolerance: number) =>
  createError(
    'webhook/timestamp_too_new',
    `Webhook timestamp is too far in the future — exceeds ${tolerance}s tolerance`,
    'Check your server clock synchronization. Clock drift detected',
  );

/** @deprecated Use WEBHOOK_TIMESTAMP_TOO_OLD or WEBHOOK_TIMESTAMP_TOO_NEW */
export const WEBHOOK_TIMESTAMP_EXPIRED = () =>
  createError(
    'webhook/timestamp_expired',
    'Webhook timestamp is outside tolerance window',
    'Ensure your server clock is synchronized',
  );

export const WEBHOOK_INVALID_SIGNATURE = () =>
  createError(
    'webhook/invalid_signature',
    'Webhook HMAC signature verification failed. Are you passing the raw request body? Use express.raw() or request.text(), not parsed JSON.',
    'Verify the webhook secret matches the one in your Rakomi dashboard',
  );

export const WEBHOOK_INVALID_SECRET = () =>
  createError(
    'webhook/invalid_secret',
    'Webhook signing secret is invalid or corrupted — key must decode to exactly 32 bytes',
    'Re-copy the signing secret from the Rakomi dashboard or rotate the key',
  );

export const WEBHOOK_MISSING_HEADER = () =>
  createError(
    'webhook/missing_header',
    'Required webhook headers missing (webhook-signature, webhook-timestamp, webhook-id)',
    'Ensure you are passing the raw request headers to verifyWebhook()',
  );

export const WEBHOOK_INVALID_BODY = () =>
  createError(
    'webhook/invalid_body',
    'Webhook body is not valid JSON',
    'Use express.raw() or express.text() middleware to preserve the raw body for webhook routes',
  );

export const CONFIG_MISSING_API_KEY = () =>
  createError(
    'config/missing_api_key',
    'apiKey is required',
    'Pass your API key when creating the client',
    'new Rakomi({ apiKey: "ca_live_xxx" })',
  );

export const CONFIG_INVALID_BASE_URL = () =>
  createError(
    'config/invalid_base_url',
    'baseUrl must be a valid HTTPS URL',
    'Use a full URL including protocol, e.g., https://api.rakomi.com',
  );

export const CONFIG_MISSING_WEBHOOK_SECRET = () =>
  createError(
    'config/missing_webhook_secret',
    'webhookSecret is required for webhook verification',
    'Pass your webhook signing key in config',
    'new Rakomi({ apiKey: "...", webhookSecret: "rksec_xxx" })',
  );

export const OAUTH_INVALID_GRANT = (detail?: string) =>
  createError(
    'oauth/invalid_grant',
    detail || 'Authorization code is invalid, expired, or already used',
    'Request a new authorization code. Codes expire after 10 minutes and can only be used once',
  );

export const OAUTH_INVALID_CLIENT = (detail?: string) =>
  createError(
    'oauth/invalid_client',
    detail || 'Client authentication failed — invalid client_id or client_secret',
    'Verify your OAuth client credentials in the Rakomi dashboard',
  );

export const OAUTH_INVALID_REQUEST = (detail?: string) =>
  createError(
    'oauth/invalid_request',
    detail || 'Invalid or missing request parameters',
    'Check that all required parameters are provided and correctly formatted',
  );

export const OAUTH_UNSUPPORTED_GRANT_TYPE = (detail?: string) =>
  createError(
    'oauth/unsupported_grant_type',
    detail || 'The grant type is not supported',
    'Use grant_type=authorization_code or grant_type=refresh_token',
  );

export const OAUTH_NETWORK_ERROR = (detail?: string) =>
  createError(
    'oauth/network_error',
    `OAuth token request failed${detail ? `: ${detail}` : ''}`,
    'Check network connectivity and that the Rakomi API is reachable',
  );

export const OAUTH_MISSING_CLIENT_ID = () =>
  createError(
    'oauth/missing_client_id',
    'clientId is required for OAuth token operations',
    'Pass clientId when creating the Rakomi client or in the options',
    'new Rakomi({ apiKey: "...", clientId: "your_client_id" })',
  );

export const OAUTH_MISSING_CLIENT_SECRET = () =>
  createError(
    'oauth/missing_client_secret',
    'clientSecret is required for OAuth token operations',
    'Pass clientSecret when creating the Rakomi client or in the options',
    'new Rakomi({ apiKey: "...", clientSecret: "your_client_secret" })',
  );

export const DEVICE_AUTHORIZATION_PENDING = (detail?: string) =>
  createError(
    'device/authorization_pending',
    detail || 'The user has not yet completed authorization',
    'Continue polling the token endpoint at the suggested interval until success, denial, or expiry',
  );

export const DEVICE_AUTHORIZATION_SLOW_DOWN = (detail?: string) =>
  createError(
    'device/slow_down',
    detail || 'Polling interval too short — increase by 5 seconds',
    'Honor the slow_down server signal: add 5s to your current interval before the next poll (RFC 8628 §3.5)',
  );

export const DEVICE_AUTHORIZATION_DENIED = (detail?: string) =>
  createError(
    'device/access_denied',
    detail || 'The user denied the authorization request',
    'Restart the device flow if the user wants to retry',
  );

export const DEVICE_AUTHORIZATION_EXPIRED = (detail?: string) =>
  createError(
    'device/expired_token',
    detail || 'The device_code has expired before user authorization completed',
    'Restart the device flow to obtain a fresh device_code + user_code',
  );

export const DEVICE_AUTHORIZATION_TIMEOUT = (detail?: string) =>
  createError(
    'device/timeout',
    detail || 'awaitDeviceTokens reached its client-side timeout before the user completed authorization',
    'Pass a longer signal/timeout, or use poll() directly so you control the wait',
  );

export const DEVICE_AUTHORIZATION_RATE_LIMITED = (detail?: string) =>
  createError(
    'device/rate_limited',
    detail || 'Too many active device codes — server returned slow_down on issuance',
    'Wait for older device codes to expire, or reduce concurrent device-flow initiations',
  );

export const ANONYMOUS_DISABLED = () =>
  createError(
    'anonymous/disabled',
    'Anonymous sign-ins are not enabled for this tenant',
    'Enable anonymous sign-ins in the Rakomi dashboard → Settings → Authentication → Anonymous',
  );

export const ANONYMOUS_RATE_LIMITED = (retryAfterSeconds?: number) =>
  createError(
    'anonymous/rate_limited',
    retryAfterSeconds
      ? `Too many anonymous sign-in requests. Retry after ${retryAfterSeconds}s.`
      : 'Too many anonymous sign-in requests',
    'Back off and retry. See https://docs.rakomi.dev/reference/auth/anonymous#rate-limits',
  );

export const ANONYMOUS_MAU_EXHAUSTED = () =>
  createError(
    'anonymous/mau_exhausted',
    'Tenant MAU cap reached — new anonymous users cannot be created until the billing period resets or the plan is upgraded.',
    'Upgrade the tenant plan in the Rakomi dashboard, or wait for the next billing period.',
  );

export const ANONYMOUS_NETWORK_ERROR = (detail?: string) =>
  createError(
    'anonymous/network_error',
    `Anonymous sign-in request failed${detail ? `: ${detail}` : ''}`,
    'Check network connectivity and that the Rakomi API is reachable',
  );

/**
 * Thrown by the auto-refresh path when a refresh returns 401 AND the prior
 * access token was marked `is_anonymous: true`. Distinguishes "the tenant
 * purged your anon user" from generic auth failures so apps can prompt a
 * fresh `client.anonymous` rather than sending the user to a login screen.
 *
 * Carries `suggestedAction: 'call_anonymous'` as a stable hint for DX-level
 * UX routing (DX thread).
 */
export class AnonymousSessionExpiredError extends Error {
  readonly code = 'anonymous/session_expired';
  readonly suggestedAction = 'call_anonymous()' as const;
  readonly suggestion: string;
  readonly docs_url: string;

  constructor(message = 'Anonymous session expired — the tenant purged the underlying anonymous user.') {
    super(message);
    this.name = 'AnonymousSessionExpiredError';
    this.suggestion = 'Call client.anonymous() to mint a fresh guest session.';
    this.docs_url = `${DOCS_BASE}#anonymous-session_expired`;
  }
}

export const ACCOUNT_LINKING_NETWORK_ERROR = (detail?: string) =>
  createError(
    'account_linking/network_error',
    `Account linking request failed${detail ? `: ${detail}` : ''}`,
    'Check network connectivity and that the Rakomi API is reachable',
  );

export const ACCOUNT_LINKING_RATE_LIMITED = (retryAfterSeconds?: number) =>
  createError(
    'account_linking/rate_limited',
    retryAfterSeconds
      ? `Too many account-linking requests. Retry after ${retryAfterSeconds}s.`
      : 'Too many account-linking requests',
    'Back off and retry. Account-linking endpoints enforce a per-user rate limit.',
  );

export const ACCOUNT_LINKING_IDENTITY_NOT_FOUND = () =>
  createError(
    'account_linking/identity_not_found',
    'No such linked identity for the caller',
    'The identity may already have been unlinked. Re-read GET /v1/users/me/link to confirm.',
  );

/**
 * Thrown when POST /v1/users/me/link/{provider} returns 403 —
 * tenant has disabled explicit self-service linking.
 */
export class AccountLinkingDisabledError extends Error {
  readonly code = 'account_linking/disabled_for_tenant';
  readonly suggestion: string;
  readonly docs_url: string;
  readonly retryAfterSeconds?: number;

  constructor(message = 'Explicit account linking is disabled for this tenant.') {
    super(message);
    this.name = 'AccountLinkingDisabledError';
    this.suggestion = 'Contact the tenant administrator. The explicit_account_linking_enabled setting is off.';
    this.docs_url = `${DOCS_BASE}#account_linking-disabled_for_tenant`;
  }
}

/**
 * Thrown when a link attempt finds the identity already owned by a different user.
 * Never include details about the other user — anti-enumeration invariant.
 */
export class IdentityOwnedByOtherUserError extends Error {
  readonly code = 'account_linking/identity_owned_by_other_user';
  readonly suggestion: string;
  readonly docs_url: string;

  constructor(message = 'The requested identity is already linked to a different account.') {
    super(message);
    this.name = 'IdentityOwnedByOtherUserError';
    this.suggestion = 'Ask the user to sign in with a different provider account, or contact support.';
    this.docs_url = `${DOCS_BASE}#account_linking-identity_owned_by_other_user`;
  }
}

/**
 * Thrown when DELETE /v1/users/me/link/{provider} would remove the user's last
 * sign-in method. Includes the remaining method kinds to inform UX.
 */
export class CannotUnlinkLastMethodError extends Error {
  readonly code = 'account_linking/cannot_unlink_last_method';
  readonly suggestion: string;
  readonly docs_url: string;
  readonly remaining_methods: readonly string[];

  constructor(remainingMethods: readonly string[] = [], message = 'Cannot unlink the user\'s last sign-in method.') {
    super(message);
    this.name = 'CannotUnlinkLastMethodError';
    this.suggestion = 'Add another sign-in method (password, passkey, or another social provider) before unlinking.';
    this.docs_url = `${DOCS_BASE}#account_linking-cannot_unlink_last_method`;
    this.remaining_methods = remainingMethods;
  }
}

/**
 * Thrown when a high-risk operation is attempted within the 1-hour post-link
 * cooldown window. Semantically distinct from rate-limit
 * 429s: clients should surface a localized "try again at {time}" hint rather
 * than "too many requests".
 *
 * Exposes both `unlockAt: Date` and `unlockAtIso: string` so consumers can
 * format the timestamp without re-parsing.
 */
export class CooldownActiveError extends Error {
  readonly code = 'account_linking/cooldown_active';
  readonly suggestion: string;
  readonly docs_url: string;
  readonly unlockAt: Date;
  readonly unlockAtIso: string;
  /**
   * User-facing discriminator so consumer UX can render a distinct copy path
   * ("you recently linked an account") vs. the generic rate-limit message.
   * Populated from the server-side `details.reason` when present.
   */
  readonly reason: 'account_recently_linked' | 'unknown';

  constructor(
    unlockAtIso: string,
    reason: 'account_recently_linked' | 'unknown' = 'account_recently_linked',
    message = 'High-risk operation temporarily locked after account linking.',
  ) {
    super(message);
    this.name = 'CooldownActiveError';
    this.unlockAtIso = unlockAtIso;
    this.unlockAt = new Date(unlockAtIso);
    this.reason = reason;
    this.suggestion = `Wait until ${unlockAtIso} before retrying. For immediate access, users can unlink the newly-linked provider.`;
    this.docs_url = `${DOCS_BASE}#account_linking-cooldown_active`;
  }
}

let mfaChallengeTokenWarningEmitted = false;
function emitMfaChallengeTokenDeprecationWarning(): void {
  if (mfaChallengeTokenWarningEmitted) return;
  mfaChallengeTokenWarningEmitted = true;
  console.warn(
    '[@rakomi/node] DEPRECATED: MfaStepUpRequiredError.mfa_challenge_token is a transitional dual-emit field and will be removed in 0.12.0. Switch to `next_action === "verify_mfa"` for MFA step-up branching. See https://docs.rakomi.dev/sdk/errors#account_linking-mfa_required',
  );
}

/**
 * Thrown when POST /v1/users/me/link/{provider} returns 401 with
 * `code: 'account_linking/mfa_required'`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9470 (Step-Up Authentication
 * Challenge Protocol — conceptual reference; the JSON-body discriminator here
 * mirrors RFC 9470's Bearer `WWW-Authenticate` step-up signal for cookie-session
 * APIs.)
 *
 * In SDK 0.11.0 the canonical post-401 discriminator is `next_action: 'verify_mfa'`
 * (mirrors Stripe `payment_intent.next_action` / AWS Cognito `ChallengeName`).
 * The `mfa_challenge_token` getter is RETAINED for backward compatibility with
 * 0.10.x consumers but will be removed in 0.12.0 — switch to `next_action`.
 *
 * Calling code: guide the user through `POST /v1/auth/step-up/password`, then
 * retry the link initiate with the resulting `X-Step-Up-Token` header.
 *
 * Note: this error is ONLY thrown for users who CAN satisfy step-up (i.e. have
 * a password set). Passwordless users (magic-link / OTP / passkey-only) get the
 * complementary {@link MfaStepUpUnavailableError} instead.
 */
export class MfaStepUpRequiredError extends Error {
  readonly code = 'account_linking/mfa_required';
  readonly suggestion: string;
  readonly docs_url: string;
  /**
   * Canonical post-401 discriminator. Always equals the literal `'verify_mfa'`
   * in SDK 0.11.x. Reserved future literals: `'verify_passkey'`,
   * `'verify_magic_link'`, `'verify_otp'`, `'verify_eudi_wallet'`.
   */
  readonly next_action = 'verify_mfa' as const;

  /**
 * The set of step-up issuance routes the current user can satisfy. The
 * client SHOULD pick one and call the corresponding `/v1/auth/step-up/*`
 * route. Order is a HINT, not a guarantee — the server may personalize
 * ordering by recent success rate or admin policy.
 *
 * Open union: backend-additive values (e.g. `ciba_push`, `eudi_wallet`)
 * MUST NOT trigger a SemVer-major bump for SDK consumers — the
 * `(string & {})` escape hatch keeps the literal-aware autocomplete
 * experience while accepting unknown strings at runtime.
 *
 * Optional: older API responses (servers older than 2026-04-26)
 * lack this field; consumers MUST handle `undefined` by falling through to
 * the legacy `next_action === 'verify_mfa'` flow.
 */
  readonly availableMethods?: ReadonlyArray<
    'password' | 'passkey' | 'magic_link' | 'email_otp' | (string & {})
  >;

  private readonly _mfaChallengeToken: string;

  /**
   * @deprecated Will be removed in 0.12.0+ once the dual-emit window expires
   * (2026-07-24). Switch to `next_action === 'verify_mfa'`. In 0.10.x this field carried the
   * literal string `'mfa_step_up_required'` (a routing marker, never a nonce);
   * the value is preserved here so existing consumers continue working through
   * the dual-emit window.
   */
  get mfa_challenge_token(): string {
    emitMfaChallengeTokenDeprecationWarning();
    return this._mfaChallengeToken;
  }

  constructor(
    mfaChallengeToken: string = 'mfa_step_up_required',
    message = 'MFA verification required before linking a new identity.',
    availableMethods?: ReadonlyArray<
      'password' | 'passkey' | 'magic_link' | 'email_otp' | (string & {})
    >,
  ) {
    super(message);
    this.name = 'MfaStepUpRequiredError';
    this._mfaChallengeToken = mfaChallengeToken;
    this.availableMethods = availableMethods;
    this.suggestion = availableMethods && availableMethods.length > 0
      ? `Direct the user through one of the available step-up methods (${availableMethods.join(', ')}) and retry the link initiate with the resulting X-Step-Up-Token header.`
      : 'Direct the user through a fresh MFA challenge, then retry the link initiate with the resulting X-Step-Up-Token header.';
    this.docs_url = `${DOCS_BASE}#account_linking-mfa_required`;
  }
}

/**
 * Thrown when POST /v1/users/me/link/{provider} returns 401 with
 * `code: 'account_linking/mfa_step_up_unavailable'` — a passwordless user
 * (magic-link / email-OTP / passkey-only) has MFA enabled but no step-up
 * issuance route exists for their authenticator class today (only
 * `POST /v1/auth/step-up/password` ships in 0.11.x).
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9470
 *
 * The complement of {@link MfaStepUpRequiredError}: together the two classes
 * partition the 401-with-MFA-enabled space. UX should surface a "complete
 * account setup (set a password)" affordance — NOT a promise of a passwordless
 * step-up flow (none exists in 0.11.x).
 */
export class MfaStepUpUnavailableError extends Error {
  readonly code = 'account_linking/mfa_step_up_unavailable';
  readonly suggestion: string;
  readonly docs_url: string;
  /**
   * Extensible enum — additional reasons reserved for future passwordless
   * step-up flows. The recognised reasons include
   * `'no_step_up_authenticator_available'`, emitted when the server finds
   * zero satisfiable methods (defensive tripwire).
   */
  readonly reason: string;

  constructor(
    reason: string = 'passwordless_user_no_step_up_route',
    message = 'No step-up authenticator is available for this account.',
  ) {
    super(message);
    this.name = 'MfaStepUpUnavailableError';
    this.reason = reason;
    this.suggestion = 'Reserved for the (now-rare) case where the user has no satisfiable step-up authenticator. Passwordless users with email or passkey receive MfaStepUpRequiredError with availableMethods populated instead.';
    this.docs_url = `${DOCS_BASE}#account_linking-mfa_step_up_unavailable`;
  }
}

/**
 * Thrown when an OAuth callback rejects a state row that expired or was
 * already used. The SDK typically surfaces this via the
 * link-list read (consumers infer the failure from a `?error=link_state_expired`
 * query string). Direct API consumers get the typed class.
 */
export class LinkStateExpiredError extends Error {
  readonly code = 'account_linking/link_state_expired_or_missing';
  readonly suggestion: string;
  readonly docs_url: string;

  constructor(message = 'The link request has expired or was already used.') {
    super(message);
    this.name = 'LinkStateExpiredError';
    this.suggestion = 'Restart the link flow from the Connected Accounts dashboard.';
    this.docs_url = `${DOCS_BASE}#account_linking-link_state_expired_or_missing`;
  }
}
