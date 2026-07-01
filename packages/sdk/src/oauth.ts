import { createHash, randomBytes } from 'node:crypto';

import { decodeJwt } from 'jose';

import type { DpopSession } from './dpop-session.js';
import {
  AUTH_DPOP_PROVER_UNAVAILABLE,
  AUTH_DPOP_ROTATION_DID_NOT_TAKE,
  AUTH_DPOP_ROTATION_NOOP,
  AUTH_INVALID_DPOP_PROOF,
  AUTH_INVALID_REFRESH_TOKEN,
  AUTH_REFRESH_SUPERSEDED_BY_ROTATION,
  OAUTH_INVALID_CLIENT,
  OAUTH_INVALID_GRANT,
  OAUTH_INVALID_REQUEST,
  OAUTH_MISSING_CLIENT_ID,
  OAUTH_NETWORK_ERROR,
  OAUTH_UNSUPPORTED_GRANT_TYPE,
  RakomiError,
} from './errors.js';
import type {
  AuthorizeUrlOptions,
  OAuthExchangeOptions,
  OAuthRefreshOptions,
  OAuthRotateOptions,
  OAuthTokenResponse,
  PkceChallenge,
  RotationTokenResponse,
  SdkError,
  VerifyResult,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';
const DEFAULT_SCOPE = 'openid profile email';

/**
 * The ONE serialization choke point every refresh_token-consuming operation
 * (ordinary {@link refreshToken} AND key {@link rotateRefreshKey}) passes through,
 * keyed by the refresh_token VALUE.
 *
 * The server one-time-uses + rotates the refresh token on EVERY successful
 * `grant_type=refresh_token`, so two operations that both carry the same token
 * value can NEVER both spend it — neither concurrently NOR sequentially —
 * without tripping server refresh-reuse detection, which nuclear-revokes the
 * whole session. A single token-keyed map is therefore the correct primitive
 * for BOTH operation kinds, not two independent latches.
 *
 * - **Same-kind** concurrency on one token COALESCES onto the single in-flight
 *   spend (preserves the refresh single-flight; the rotation single-flight
 *   = one keygen). Both callers receive the identical result.
 * - **Cross-kind** concurrency on one token FAILS-SAFE on the loser WITHOUT a
 *   second network call: the winner owns (and will spend) the token; the loser
 *   surfaces a distinct, retry-able signal ({@link AUTH_REFRESH_SUPERSEDED_BY_ROTATION}
 *   for a refresh that lost to a rotation; {@link AUTH_DPOP_ROTATION_DID_NOT_TAKE}
 *   for a rotation that lost to a refresh) — never a double-spend, never a nuclear
 *   logout.
 *
 * INVARIANT: any NEW SDK code path that POSTs `grant_type=refresh_token` MUST be
 * routed through {@link withRefreshTokenGate} — do not add a third un-coordinated
 * consumer.
 */
type RefreshOpKind = 'refresh' | 'rotation';
interface InflightRefreshOp {
  kind: RefreshOpKind;
  promise: Promise<VerifyResult<OAuthTokenResponse>>;
}
const inflightByToken = new Map<string, InflightRefreshOp>();

/**
 * Run a refresh_token-consuming operation under the token-keyed gate. Same-kind
 * concurrency coalesces; cross-kind concurrency fails-safe on the loser (no second
 * spend). The gate entry is registered SYNCHRONOUSLY before the first async
 * signing (TOCTOU pin) so a racing same-token operation observes it, never a gap.
 */
async function withRefreshTokenGate<T extends OAuthTokenResponse>(
  token: string,
  kind: RefreshOpKind,
  crossKindFailSafe: () => SdkError,
  run: () => Promise<VerifyResult<T>>,
): Promise<VerifyResult<T>> {
  const existing = inflightByToken.get(token);
  if (existing) {
    if (existing.kind === kind) {
      return existing.promise as Promise<VerifyResult<T>>;
    }
    return { ok: false, error: crossKindFailSafe() };
  }
  const promise = run();
  inflightByToken.set(token, { kind, promise });
  try {
    return await promise;
  } finally {
    inflightByToken.delete(token);
  }
}

/**
 * Generate a PKCE code verifier and challenge pair.
 * Uses node:crypto for secure random generation.
 */
export function generatePKCE(): PkceChallenge {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/**
 * Generate a random state parameter for CSRF protection.
 * Returns 32 random bytes, hex-encoded.
 */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Build a full /oauth/authorize URL with all required parameters.
 * Pure function — no config dependency, usable without RakomiClient instance.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const scope =
    Array.isArray(options.scope) ? options.scope.join(' ') : (options.scope ?? DEFAULT_SCOPE);

  const url = new URL('/oauth/authorize', baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Exchange an authorization code for tokens via POST /oauth/token.
 * Never throws — returns VerifyResult<OAuthTokenResponse>.
 */
export async function exchangeCode(
  options: OAuthExchangeOptions,
): Promise<VerifyResult<OAuthTokenResponse>> {
  try {
    const clientId = options.clientId;
    const clientSecret = options.clientSecret;

    if (!clientId) {
      throw new RakomiError(OAUTH_MISSING_CLIENT_ID());
    }

    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: clientId,
      code_verifier: options.codeVerifier,
    };
    if (clientSecret) {
      params.client_secret = clientSecret;
    }
    const body = new URLSearchParams(params);

    const session = options.dpop;
    let dpopProof: string | undefined;
    if (session) {
      try {
        dpopProof = await session.resolveProof('POST', '/oauth/token');
      } catch {
        return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
      }
      if (!dpopProof) {
        return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
      }
    }

    const outcome = await tokenRequest(baseUrl, body, dpopProof);
    if (session && outcome.result.ok) {
      await session.observeTokenType(outcome.result.data.token_type, dpopProof !== undefined);
    }
    return outcome.result;
  } catch (err) {
    if (err instanceof RakomiError) {
      return { ok: false, error: { code: err.code, message: err.message, suggestion: err.suggestion, docs_url: err.docs_url } };
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: OAUTH_NETWORK_ERROR(detail) };
  }
}

/**
 * Refresh an OAuth token via POST /oauth/token.
 * Serializes concurrent calls with the same refresh token to prevent nuclear revocation.
 * Never throws — returns VerifyResult<OAuthTokenResponse>.
 */
export async function refreshToken(
  options: OAuthRefreshOptions,
): Promise<VerifyResult<OAuthTokenResponse>> {
  try {
    if (!options.clientId) {
      throw new RakomiError(OAUTH_MISSING_CLIENT_ID());
    }

    return await withRefreshTokenGate(
      options.refreshToken,
      'refresh',
      () => AUTH_REFRESH_SUPERSEDED_BY_ROTATION(),
      () => executeRefresh(options),
    );
  } catch (err) {
    if (err instanceof RakomiError) {
      return { ok: false, error: { code: err.code, message: err.message, suggestion: err.suggestion, docs_url: err.docs_url } };
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: OAUTH_NETWORK_ERROR(detail) };
  }
}

/**
 * Perform an in-band DPoP refresh-key ROTATION via POST /oauth/token
 * Co-presents the OLD-key proof (the
 * session's current key, on the primary `DPoP` header — backward-safe) and a
 * fresh NEW-key proof (on the `DPoP-Rotate` header) on ONE refresh request, then
 * atomically swaps the session's active prover to the new key ONLY after the
 * server confirms a 200 whose access-token `cnf.jkt` EQUALS the new key's `jkt`
 * (the master invariant). Any other outcome keeps the OLD key bound (fail-SAFE,
 * never a half-swap) and surfaces a distinct non-success signal.
 *
 * This is a DEDICATED ceremony, not a flag on {@link refreshToken}: the second
 * key is created only inside this call frame, so a `DPoP-Rotate` header is
 * structurally impossible to attach to an ordinary refresh. Single-flight
 * per session — a concurrent rotation coalesces. Never throws; always resolves to
 * a `VerifyResult`.
 *
 * @public — additive-only after the first public release.
 */
export async function rotateRefreshKey(
  options: OAuthRotateOptions,
): Promise<VerifyResult<RotationTokenResponse>> {
  try {
    if (!options.clientId) {
      throw new RakomiError(OAUTH_MISSING_CLIENT_ID());
    }
    const session = options.dpop;
    if (session.isBound !== true) {
      return {
        ok: false,
        error: AUTH_INVALID_DPOP_PROOF(
          'Cannot rotate the key of a session that is not DPoP-bound. (Re)bind via exchangeCode first.',
        ),
      };
    }
    return await withRefreshTokenGate(
      options.refreshToken,
      'rotation',
      () =>
        AUTH_DPOP_ROTATION_DID_NOT_TAKE(
          'A concurrent ordinary refresh is consuming this refresh token; the rotation was not sent. Retry the rotation with the rotated refresh token.',
        ),
      () => session.runExclusiveRotation(() => executeRotation(options, session)),
    );
  } catch (err) {
    if (err instanceof RakomiError) {
      return { ok: false, error: { code: err.code, message: err.message, suggestion: err.suggestion, docs_url: err.docs_url } };
    }
    const detail = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: OAUTH_NETWORK_ERROR(detail) };
  }
}

const REFRESH_PATH = '/oauth/token';

/**
 * Run the rotation ceremony INSIDE the session's single-flight latch. Builds both
 * proofs (call-scoped incoming prover), sends the dual-header request, does the
 * single bounded nonce retry REUSING the incoming prover (no second keygen), and
 * finalizes via the master invariant. Never throws.
 */
async function executeRotation(
  options: OAuthRotateOptions,
  session: DpopSession,
): Promise<VerifyResult<RotationTokenResponse>> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId!,
  };
  if (options.clientSecret) {
    params.client_secret = options.clientSecret;
  }
  const body = new URLSearchParams(params);

  let proofs;
  try {
    proofs = await session.resolveRotationProofs('POST', REFRESH_PATH);
  } catch {
    return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
  }
  if (!proofs.oldProof || !proofs.newProof) {
    return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
  }

  let outcome = await tokenRequest(baseUrl, body, proofs.oldProof, proofs.newProof);

  if (outcome.nonceChallenge !== undefined) {
    let retry;
    try {
      retry = await session.resolveRotationProofs('POST', REFRESH_PATH, {
        nonce: outcome.nonceChallenge,
        incoming: proofs.incoming,
      });
    } catch {
      return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
    }
    if (!retry.oldProof || !retry.newProof) {
      return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
    }
    outcome = await tokenRequest(baseUrl, body, retry.oldProof, retry.newProof);
  }

  return finalizeRotation(outcome, session, proofs.incoming, proofs.newJkt);
}

/**
 * The master invariant: a rotation succeeded ONLY when the response is a
 * 200 with `token_type:"DPoP"` AND an observed access-token `cnf.jkt` that EQUALS
 * the new key's `jkt`. EVERY other outcome keeps the OLD prover (fail-SAFE) and
 * surfaces a distinct non-success signal. The one positive check defends the
 * half-swap, the rotation-suppression (stripped/malformed `DPoP-Rotate`), and the
 * rotation-unaware-server 200-on-old-key cases simultaneously.
 */
async function finalizeRotation(
  outcome: TokenRequestOutcome,
  session: DpopSession,
  incoming: import('./dpop.js').DpopProver,
  newJkt: string,
): Promise<VerifyResult<RotationTokenResponse>> {
  if (!outcome.result.ok) {
    return mapRotationError(outcome);
  }
  const data = outcome.result.data;
  const observedJkt = decodeCnfJkt(data.access_token);
  if (data.token_type === 'DPoP' && observedJkt !== undefined && observedJkt === newJkt) {
    const committed = await session.commitRotation(incoming);
    if (committed) {
      return { ok: true, data: { ...data, rotated: true } };
    }
    return { ok: false, error: AUTH_DPOP_ROTATION_DID_NOT_TAKE('Local bound-key invariant prevented the swap') };
  }
  await session.observeTokenType(data.token_type, true);
  return { ok: true, data: { ...data, rotated: false } };
}

/**
 * Map a non-200 rotation outcome to the SDK taxonomy. `rotation_noop` (the
 * server's `400 invalid_request` reason, read from the Rakomi API error
 * envelope's `details.reason`) becomes the distinct {@link AUTH_DPOP_ROTATION_NOOP}; the
 * OLD/NEW proof rejects (`401 invalid_dpop_proof` via `WWW-Authenticate`) are
 * already mapped to {@link AUTH_INVALID_DPOP_PROOF} by `tokenRequest`; everything
 * else (network, `invalid_grant`→refresh-token) flows through `remapRefreshError`.
 */
function mapRotationError(outcome: TokenRequestOutcome): { ok: false; error: SdkError } {
  if (outcome.errorReason === 'rotation_noop') {
    return { ok: false, error: AUTH_DPOP_ROTATION_NOOP() };
  }
  const mapped = remapRefreshError(outcome.result);
  return mapped.ok
    ? { ok: false, error: OAUTH_NETWORK_ERROR('Unexpected success on the rotation error path') }
    : mapped;
}

/**
 * Decode the RFC 7800 `cnf.jkt` confirmation claim from a DPoP-bound access
 * token. Reads the claim WITHOUT signature verification (the SDK is not the
 * token's audience — it only needs the server-asserted bound thumbprint to gate
 * the local prover swap). Returns `undefined` for a malformed token or an absent
 * `cnf.jkt` (treated as rotation-did-not-take by the caller).
 */
function decodeCnfJkt(accessToken: string): string | undefined {
  try {
    const claims = decodeJwt(accessToken) as { cnf?: { jkt?: unknown } };
    const jkt = claims.cnf?.jkt;
    return typeof jkt === 'string' && jkt.length > 0 ? jkt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build + send the refresh request, attaching a DPoP proof when the session is
 * bound, with a single bounded nonce-challenge retry. Never throws —
 * always resolves to a `VerifyResult`. Runs INSIDE the single-flight critical
 * section registered by `refreshToken`.
 */
async function executeRefresh(
  options: OAuthRefreshOptions,
): Promise<VerifyResult<OAuthTokenResponse>> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const session = options.dpop;
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId!,
  };
  if (options.clientSecret) {
    params.client_secret = options.clientSecret;
  }
  const body = new URLSearchParams(params);

  const attachProof = session?.isBound === true;
  if (!attachProof) {
    const outcome = await tokenRequest(baseUrl, body);
    if (session && outcome.result.ok) {
      await session.observeTokenType(outcome.result.data.token_type, false);
    }
    return remapRefreshError(outcome.result);
  }

  const proof = await resolveRefreshProof(session!);
  if (proof === null) {
    return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
  }
  const outcome = await tokenRequest(baseUrl, body, proof);

  if (outcome.nonceChallenge !== undefined) {
    const retryProof = await resolveRefreshProof(session!, outcome.nonceChallenge);
    if (retryProof === null) {
      return { ok: false, error: AUTH_DPOP_PROVER_UNAVAILABLE() };
    }
    const retryOutcome = await tokenRequest(baseUrl, body, retryProof);
    if (retryOutcome.result.ok) {
      await session!.observeTokenType(retryOutcome.result.data.token_type, true);
    }
    return remapRefreshError(retryOutcome.result);
  }

  if (outcome.result.ok) {
    await session!.observeTokenType(outcome.result.data.token_type, true);
  }
  return remapRefreshError(outcome.result);
}

/**
 * Resolve a refresh proof string from the session prover. Returns `null` (NOT a
 * malformed/empty header) when the signer throws or yields a falsy value — the
 * caller maps that to `auth/dpop_prover_unavailable` (never a silent Bearer
 * downgrade). A fresh proof ⇒ a fresh `jti` per HTTP attempt.
 */
async function resolveRefreshProof(session: DpopSession, nonce?: string): Promise<string | null> {
  try {
    const proof = await session.resolveProof('POST', REFRESH_PATH, nonce !== undefined ? { nonce } : undefined);
    return proof || null;
  } catch {
    return null;
  }
}

/**
 * On the refresh operation, an RFC 6749 `invalid_grant` means the refresh token
 * itself is revoked/expired — surface the distinct `auth/invalid_refresh_token`
 * (class 3), keeping it separable from `auth/invalid_dpop_proof` (class 2) so
 * a caller can tell a recoverable proof problem from a genuine revocation.
 * exchangeCode keeps `oauth/invalid_grant`
 * (an invalid authorization code is a different failure).
 */
function remapRefreshError(
  result: VerifyResult<OAuthTokenResponse>,
): VerifyResult<OAuthTokenResponse> {
  if (!result.ok && result.error.code === 'oauth/invalid_grant') {
    return { ok: false, error: AUTH_INVALID_REFRESH_TOKEN(result.error.message) };
  }
  return result;
}

const RFC6749_ERROR_MAP: Record<string, (detail?: string) => SdkError> = {
  invalid_grant: OAUTH_INVALID_GRANT,
  invalid_client: OAUTH_INVALID_CLIENT,
  invalid_request: OAUTH_INVALID_REQUEST,
  unsupported_grant_type: OAUTH_UNSUPPORTED_GRANT_TYPE,
};

/**
 * Result of a single POST /oauth/token attempt.
 *
 * `nonceChallenge` is set ONLY when the server responded with an RFC 9449 §8
 * `use_dpop_nonce` challenge carrying a `DPoP-Nonce` response header — the
 * caller (`executeRefresh`) does the single bounded retry. `result` already
 * carries the terminal `auth/invalid_dpop_proof` so that if the retry is not
 * taken the surfaced error is correct.
 */
interface TokenRequestOutcome {
  result: VerifyResult<OAuthTokenResponse>;
  nonceChallenge?: string;
  /**
   * The granular `details.reason` from a first-party Rakomi API error envelope
   * (e.g. `rotation_noop`), when present. Lets the rotation finalizer surface the
   * distinct `auth/dpop_rotation_noop` signal that the generic RFC 6749 mapping
   * would otherwise flatten to `invalid_request`.
   */
  errorReason?: string;
}

/**
 * Build the token-endpoint headers. Adds the `DPoP` header iff an OLD-key proof
 * is supplied, and the `DPoP-Rotate` header iff a NEW-key (rotation) proof is
 * supplied. Both are `set` (replace) semantics — a duplicated header would
 * comma-join server-side into a malformed proof → DEGRADE.
 */
function buildTokenHeaders(dpopProof?: string, dpopRotateProof?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (dpopProof) {
    headers.DPoP = dpopProof;
  }
  if (dpopRotateProof) {
    headers['DPoP-Rotate'] = dpopRotateProof;
  }
  return headers;
}

/** Detect an RFC 9449 challenge value in a `WWW-Authenticate: DPoP …` header (case-insensitive on the keyword). */
function wwwAuthenticateHasError(headerValue: string | null, error: string): boolean {
  if (!headerValue) return false;
  return new RegExp(`error="${error}"`).test(headerValue);
}

async function tokenRequest(
  baseUrl: string,
  body: URLSearchParams,
  dpopProof?: string,
  dpopRotateProof?: string,
): Promise<TokenRequestOutcome> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      headers: buildTokenHeaders(dpopProof, dpopRotateProof),
      body,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Network error';
    return { result: { ok: false, error: OAUTH_NETWORK_ERROR(detail) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return {
      result: { ok: false, error: OAUTH_NETWORK_ERROR('Invalid JSON response from token endpoint') },
    };
  }

  if (!response.ok) {
    const errorBody = json as Record<string, unknown>;
    const errorObj =
      typeof errorBody.error === 'object' && errorBody.error !== null
        ? (errorBody.error as Record<string, unknown>)
        : undefined;
    const errorCode = typeof errorBody.error === 'string' ? errorBody.error : 'unknown';
    const errorDescription =
      typeof errorBody.error_description === 'string'
        ? errorBody.error_description
        : errorObj && typeof errorObj.message === 'string'
          ? errorObj.message
          : undefined;
    const details =
      errorObj && typeof errorObj.details === 'object' && errorObj.details !== null
        ? (errorObj.details as Record<string, unknown>)
        : undefined;
    const errorReason = details && typeof details.reason === 'string' ? details.reason : undefined;
    const wwwAuth = response.headers.get('WWW-Authenticate');

    if (errorCode === 'use_dpop_nonce' || wwwAuthenticateHasError(wwwAuth, 'use_dpop_nonce')) {
      const nonce = response.headers.get('DPoP-Nonce');
      return {
        result: { ok: false, error: AUTH_INVALID_DPOP_PROOF(errorDescription) },
        ...(nonce !== null && nonce.length > 0 ? { nonceChallenge: nonce } : {}),
      };
    }

    if (errorCode === 'invalid_dpop_proof' || wwwAuthenticateHasError(wwwAuth, 'invalid_dpop_proof')) {
      return { result: { ok: false, error: AUTH_INVALID_DPOP_PROOF(errorDescription) } };
    }

    const factory = RFC6749_ERROR_MAP[errorCode];
    if (factory) {
      return { result: { ok: false, error: factory(errorDescription) }, ...(errorReason !== undefined && { errorReason }) };
    }

    return {
      result: { ok: false, error: OAUTH_INVALID_REQUEST(errorDescription || `Token endpoint error: ${errorCode}`) },
      ...(errorReason !== undefined && { errorReason }),
    };
  }

  const data = json as Record<string, unknown>;
  if (
    typeof data.access_token !== 'string' ||
    data.access_token.length === 0 ||
    data.access_token.length > 8192 ||
    typeof data.token_type !== 'string'
  ) {
    return {
      result: { ok: false, error: OAUTH_NETWORK_ERROR('Invalid token response: missing or oversized access_token or token_type') },
    };
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) {
    return {
      result: { ok: false, error: OAUTH_NETWORK_ERROR('Invalid token response: expires_in out of acceptable range [1, 86400]') },
    };
  }

  return { result: { ok: true, data: json as OAuthTokenResponse } };
}
