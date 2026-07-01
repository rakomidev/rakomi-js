/**
 * Node SDK surface for user-scoped account linking.
 *
 * Wraps the three `/v1/users/me/link*` endpoints.
 * These endpoints require an end-user JWT (NOT an API key), so each helper
 * takes a `{ userToken }` option. The SDK client (constructed with an API key)
 * only carries the `baseUrl`; the user token flows per-call.
 *
 * Returns the shared `VerifyResult` shape — NEVER throws on expected 4xx.
 * Typed error classes (AccountLinkingDisabledError, IdentityOwnedByOtherUserError,
 * CannotUnlinkLastMethodError) are also exported for callers that prefer
 * pattern-matching via `instanceof` over inspecting `error.code`.
 */

import {
  ACCOUNT_LINKING_IDENTITY_NOT_FOUND,
  ACCOUNT_LINKING_NETWORK_ERROR,
  ACCOUNT_LINKING_RATE_LIMITED,
  AccountLinkingDisabledError,
  CannotUnlinkLastMethodError,
  CooldownActiveError,
  IdentityOwnedByOtherUserError,
  LinkStateExpiredError,
  MfaStepUpRequiredError,
  MfaStepUpUnavailableError,
} from './errors.js';
import type { SdkError, VerifyResult } from './types.js';

export type AccountLinkingProvider =
  | 'google'
  | 'github'
  | 'microsoft'
  | 'apple'
  | 'discord'
  | 'facebook'
  | 'slack'
  | 'twitter'
  | 'gitlab'
  | 'linkedin';

export type LinkedVia = 'signup' | 'explicit_link' | 'automatic_link';

export type LinkedMethod =
  | { kind: 'password'; active: boolean }
  | {
      kind: 'social';
      provider: AccountLinkingProvider;
      provider_email_hash: string;
      linked_at: string;
      linked_via: LinkedVia;
    }
  | { kind: 'passkey'; count: number };

export interface LinkedMethodsResponse {
  methods: LinkedMethod[];
  cooldown_until: string | null;
}

export interface LinkInitiateResponse {
  authorization_url: string;
}

export interface UnlinkResponse {
  unlinked: boolean;
  provider: AccountLinkingProvider;
  warnings: Array<'only_password_remains'>;
}

export interface LinkCallOptions {
  /** End-user JWT (Bearer). REQUIRED — these endpoints do NOT accept API keys. */
  userToken: string;
}

export interface LinkInitiateOptions extends LinkCallOptions {
  redirectUri: string;
  /** Optional MFA step-up token (forward path — server-side gate lives in). */
  mfaVerificationToken?: string;
}

export interface LinkClientContext {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ApiErrorBody {
  code?: string;
  message?: string;
  next_action?: string;
  mfa_challenge_token?: string;
  available_methods?: string[];
  details?: {
    remaining_methods?: string[];
    unlock_at?: string;
    reason?: string;
    mfa_challenge_token?: string;
    next_action?: string;
    available_methods?: string[];
  };
}

function parseRetryAfter(res: Response): number | undefined {
  const retryAfter = res.headers.get('retry-after');
  if (!retryAfter) return undefined;
  const n = Number(retryAfter);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const ts = Date.parse(retryAfter);
  if (!Number.isFinite(ts)) return undefined;
  const delta = Math.round((ts - Date.now()) / 1000);
  return delta > 0 ? delta : undefined;
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    return (await res.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}

/**
 * User-scoped account-linking resource. Attached to `RakomiClient#link`.
 *
 * All methods require an end-user JWT passed via `{ userToken }`. The underlying
 * `RakomiClient` API key is NOT sent on these calls — the API rejects API-key
 * auth on user-scoped routes.
 */
export class LinkClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(ctx: LinkClientContext) {
    this.baseUrl = ctx.baseUrl;
    this.fetchImpl = ctx.fetchImpl ?? fetch;
  }

  /** GET /v1/users/me/link — list linked methods for the authenticated user. */
  async list(options: LinkCallOptions): Promise<VerifyResult<LinkedMethodsResponse>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/users/me/link`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.userToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
      });
    } catch (err) {
      return {
        ok: false,
        error: ACCOUNT_LINKING_NETWORK_ERROR(err instanceof Error ? err.message : undefined),
      };
    }

    if (res.status === 200) {
      const body = await safeJson<LinkedMethodsResponse>(res);
      if (!body || !Array.isArray(body.methods)) {
        return { ok: false, error: ACCOUNT_LINKING_NETWORK_ERROR('malformed response body') };
      }
      return { ok: true, data: body };
    }

    return { ok: false, error: await this.mapError(res, 'list') };
  }

  /** POST /v1/users/me/link/{provider} — initiate OAuth link flow. */
  async initiate(
    provider: AccountLinkingProvider,
    options: LinkInitiateOptions,
  ): Promise<VerifyResult<LinkInitiateResponse>> {
    const body: Record<string, string> = { redirect_uri: options.redirectUri };
    if (options.mfaVerificationToken) {
      body.mfa_verification_token = options.mfaVerificationToken;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/v1/users/me/link/${encodeURIComponent(provider)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.userToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
        },
      );
    } catch (err) {
      return {
        ok: false,
        error: ACCOUNT_LINKING_NETWORK_ERROR(err instanceof Error ? err.message : undefined),
      };
    }

    if (res.status === 200) {
      const body = await safeJson<LinkInitiateResponse>(res);
      if (!body || typeof body.authorization_url !== 'string') {
        return { ok: false, error: ACCOUNT_LINKING_NETWORK_ERROR('malformed response body') };
      }
      if (!/^https?:\/\//i.test(body.authorization_url)) {
        return { ok: false, error: ACCOUNT_LINKING_NETWORK_ERROR('invalid authorization_url scheme') };
      }
      return { ok: true, data: body };
    }

    return { ok: false, error: await this.mapError(res, 'initiate') };
  }

  /** DELETE /v1/users/me/link/{provider} — unlink a social identity. */
  async remove(
    provider: AccountLinkingProvider,
    options: LinkCallOptions,
  ): Promise<VerifyResult<UnlinkResponse>> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/v1/users/me/link/${encodeURIComponent(provider)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${options.userToken}`,
            Accept: 'application/json',
          },
          redirect: 'error',
        },
      );
    } catch (err) {
      return {
        ok: false,
        error: ACCOUNT_LINKING_NETWORK_ERROR(err instanceof Error ? err.message : undefined),
      };
    }

    if (res.status === 200) {
      const body = await safeJson<UnlinkResponse>(res);
      if (!body || typeof body.unlinked !== 'boolean') {
        return { ok: false, error: ACCOUNT_LINKING_NETWORK_ERROR('malformed response body') };
      }
      return { ok: true, data: body };
    }

    return { ok: false, error: await this.mapError(res, 'remove') };
  }

  private async mapError(res: Response, op: 'list' | 'initiate' | 'remove'): Promise<SdkError> {
    const body = await parseErrorBody(res);
    const code = body.code ?? '';

    switch (res.status) {
      case 400:
        if (code === 'account_linking/link_state_expired_or_missing') {
          const err = new LinkStateExpiredError(body.message);
          return sdkErrorFromClass(err);
        }
        break;
      case 401:
        if (code === 'account_linking/mfa_step_up_unavailable') {
          const err = new MfaStepUpUnavailableError(
            'passwordless_user_no_step_up_route',
            body.message,
          );
          return sdkErrorFromClass(err, { reason: err.reason });
        }
        if (code === 'account_linking/mfa_required') {
          const challenge = typeof body.mfa_challenge_token === 'string'
            ? body.mfa_challenge_token
            : typeof body.details?.mfa_challenge_token === 'string'
              ? body.details.mfa_challenge_token
              : 'mfa_step_up_required';
          const availableRaw = Array.isArray(body.available_methods)
            ? body.available_methods
            : Array.isArray(body.details?.available_methods)
              ? body.details!.available_methods
              : undefined;
          const availableMethods = availableRaw && availableRaw.length > 0
            ? (availableRaw.filter((m) => typeof m === 'string') as ReadonlyArray<
                'password' | 'passkey' | 'magic_link' | 'email_otp' | (string & {})
              >)
            : undefined;
          const err = new MfaStepUpRequiredError(
            challenge,
            body.message,
            availableMethods,
          );
          return sdkErrorFromClass(err, {
            next_action: err.next_action,
            ...(availableMethods ? { available_methods: [...availableMethods] } : {}),
          });
        }
        return {
          code: 'account_linking/unauthorized',
          message: body.message || 'User token is missing, expired, or invalid.',
          suggestion: 'Re-authenticate the end user and retry with a fresh access token.',
          docs_url: 'https://docs.rakomi.dev/sdk/errors#account_linking-unauthorized',
        } as SdkError;
      case 403:
        if (code === 'account_linking/disabled_for_tenant') {
          const err = new AccountLinkingDisabledError(body.message);
          return sdkErrorFromClass(err);
        }
        return {
          code: code || 'account_linking/forbidden',
          message: body.message || 'Forbidden',
          suggestion: 'The end user is not permitted to perform this account-linking operation.',
          docs_url: 'https://docs.rakomi.dev/sdk/errors#account_linking-forbidden',
        } as SdkError;
      case 404:
        if (code === 'account_linking/identity_not_found' || (op === 'remove' && !code)) {
          return ACCOUNT_LINKING_IDENTITY_NOT_FOUND();
        }
        return {
          code: code || 'account_linking/not_found',
          message: body.message || `HTTP 404`,
          suggestion: 'The requested resource was not found.',
          docs_url: 'https://docs.rakomi.dev/sdk/errors#account_linking-not_found',
        } as SdkError;
      case 409:
        if (code === 'account_linking/cannot_unlink_last_method') {
          const err = new CannotUnlinkLastMethodError(
            body.details?.remaining_methods ?? [],
            body.message,
          );
          return sdkErrorFromClass(err, { remaining_methods: err.remaining_methods });
        }
        if (code === 'account_linking/identity_owned_by_other_user') {
          const err = new IdentityOwnedByOtherUserError(body.message);
          return sdkErrorFromClass(err);
        }
        break;
      case 429:
        if (code === 'account_linking/cooldown_active') {
          const unlockAt = typeof body.details?.unlock_at === 'string'
            ? body.details.unlock_at
            : new Date(Date.now() + 60 * 60 * 1000).toISOString();
          const reason = body.details?.reason === 'account_recently_linked'
            ? 'account_recently_linked'
            : 'unknown';
          const err = new CooldownActiveError(unlockAt, reason, body.message);
          return sdkErrorFromClass(err, {
            unlock_at: err.unlockAtIso,
            reason: err.reason,
          });
        }
        return ACCOUNT_LINKING_RATE_LIMITED(parseRetryAfter(res));
    }

    const truncated = (body.message ?? '').slice(0, 200);
    return ACCOUNT_LINKING_NETWORK_ERROR(truncated || `HTTP ${res.status}`);
  }
}

const DOCS_BASE = 'https://docs.rakomi.dev/sdk/errors';

/**
 * Convert a typed Error class instance into the SDK's SdkError object shape.
 * Callers who want the typed class can still `instanceof` the exported classes;
 * this bridge lets the Result-returning APIs emit structured errors without
 * throwing.
 */
function sdkErrorFromClass(
  err:
    | AccountLinkingDisabledError
    | IdentityOwnedByOtherUserError
    | CannotUnlinkLastMethodError
    | CooldownActiveError
    | MfaStepUpRequiredError
    | MfaStepUpUnavailableError
    | LinkStateExpiredError,
  extra?: Record<string, unknown>,
): SdkError {
  const base: Record<string, unknown> = {
    code: err.code,
    message: err.message,
    suggestion: err.suggestion,
    docs_url: err.docs_url ?? `${DOCS_BASE}#${err.code.replace('/', '-')}`,
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) base[k] = v;
  }
  return base as unknown as SdkError;
}
