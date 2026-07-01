/**
 * OIDC CIBA Core 1.0 (asynchronous user consent) helper.
 *
 * Three-step API for AI agents that need user approval out-of-band:
 * - `initiate(options)` → POST /oauth/bc-authorize. Returns `auth_req_id`.
 * - `poll(authReqId)` → POST /oauth/token grant=urn:openid:params:grant-type:ciba.
 * - `awaitDecision(options)`→ poll-loop with adaptive interval; resolves on
 * approve / deny / expiry / AbortSignal.
 *
 * Confidential-only: the SDK requires a non-empty `clientSecret` on the
 * RakomiClient config. Browser/edge runtimes that cannot keep a secret MUST
 * use the device-grant flow instead.
 */
import { CIBA_GRANT_TYPE } from './internal/shared-constants.js';
import type { SdkError, VerifyResult } from './types.js';

export interface CibaInitiateOptions {
  /** Space-delimited or array-of-strings scopes. MUST include `openid`. */
  scope: string | string[];
  /** Email or user UUID identifying the human approver. */
  loginHint: string;
  /** Human-readable description of the action being authorized. ≤256 chars. */
  bindingMessage: string;
  /** Optional bound expiry (60–600s). Server default 120s. */
  requestedExpiry?: number;
  /** Optional IETF BCP 47 locale tag (e.g. `pl-PL`). */
  locale?: string;
}

export interface CibaInitiateResponse {
  authReqId: string;
  expiresIn: number;
  interval: number;
}

export interface CibaPollResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string;
  idToken?: string;
}

export class CibaError extends Error {
  readonly code: string;
  readonly description: string;
  constructor(code: string, description: string) {
    super(`${code}: ${description}`);
    this.code = code;
    this.description = description;
  }
}

export class CibaAuthorizationPendingError extends CibaError {
  constructor(d = 'authorization_pending') { super('authorization_pending', d); }
}
export class CibaSlowDownError extends CibaError {
  constructor(d = 'slow_down') { super('slow_down', d); }
}
export class CibaAccessDeniedError extends CibaError {
  constructor(d = 'access_denied') { super('access_denied', d); }
}
export class CibaExpiredTokenError extends CibaError {
  constructor(d = 'expired_token') { super('expired_token', d); }
}
export class CibaReplayError extends CibaError {
  constructor(d: string) { super('invalid_grant', d); }
}
export class CibaInvalidClientError extends CibaError {
  constructor(d: string) { super('invalid_client', d); }
}
export class CibaInvalidScopeError extends CibaError {
  constructor(d: string) { super('invalid_scope', d); }
}
export class CibaUnauthorizedClientError extends CibaError {
  constructor(d: string) { super('unauthorized_client', d); }
}
export class CibaUnknownUserError extends CibaError {
  constructor(d: string) { super('unknown_user_id', d); }
}
export class CibaUserCapReachedError extends CibaError {
  constructor(d: string) { super('user_cap_reached', d); }
}
export class CibaInvalidRequestError extends CibaError {
  constructor(d: string) { super('invalid_request', d); }
}

interface CibaContext {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

function basicAuth(clientId: string, secret: string): string {
  const raw = `${clientId}:${secret}`;
  if (typeof Buffer !== 'undefined') return `Basic ${Buffer.from(raw).toString('base64')}`;
  return `Basic ${btoa(raw)}`;
}

function makeError(code: string, description: string): SdkError {
  return {
    code: `ciba/${code}`,
    message: description,
    suggestion:
      code === 'unknown_user_id'
        ? 'Verify the login_hint matches a real user in this tenant.'
        : code === 'authorization_pending'
          ? 'Continue polling at the interval the server returned.'
          : code === 'slow_down'
            ? 'Server-mandated back-off — increase polling interval by 5s.'
            : code === 'invalid_scope'
              ? 'Requested scope is empty after intersection. Reduce the scope set or extend the client allowlist.'
              : 'See description; consult Starlight docs for CIBA grant.',
    docs_url: 'https://docs.rakomi.dev/oauth/ciba',
  };
}

/**
 * Initiate a CIBA authentication request via POST /oauth/bc-authorize.
 *
 * SSRF hardening: `redirect: 'error'` on fetch.
 */
export async function initiateCiba(
  ctx: CibaContext,
  options: CibaInitiateOptions,
): Promise<VerifyResult<CibaInitiateResponse>> {
  const params = new URLSearchParams();
  params.set('client_id', ctx.clientId);
  const scopeStr = Array.isArray(options.scope) ? options.scope.join(' ') : options.scope;
  params.set('scope', scopeStr);
  params.set('login_hint', options.loginHint);
  params.set('binding_message', options.bindingMessage);
  if (options.requestedExpiry !== undefined) {
    params.set('requested_expiry', String(options.requestedExpiry));
  }
  if (options.locale !== undefined) {
    params.set('binding_message_locale', options.locale);
  }

  let res: Response;
  try {
    res = await fetch(`${ctx.baseUrl}/oauth/bc-authorize`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(ctx.clientId, ctx.clientSecret),
      },
      body: params.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'ciba/network_error',
        message: (err as Error)?.message ?? 'Network error',
        suggestion: 'Verify Rakomi base URL is reachable and that DNS / TLS is healthy.',
        docs_url: 'https://docs.rakomi.dev/oauth/ciba',
      },
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
  }

  if (res.ok) {
    const authReqId = body.auth_req_id as string | undefined;
    const expiresIn = body.expires_in as number | undefined;
    const interval = body.interval as number | undefined;
    if (
      typeof authReqId !== 'string' ||
      typeof expiresIn !== 'number' ||
      typeof interval !== 'number'
    ) {
      return {
        ok: false,
        error: {
          code: 'ciba/malformed_response',
          message: 'Server returned 200 with a body that does not match OIDC CIBA Core §7.3 shape',
          suggestion: 'Server-side bug — file an issue.',
          docs_url: 'https://docs.rakomi.dev/oauth/ciba',
        },
      };
    }
    return { ok: true, data: { authReqId, expiresIn, interval } };
  }

  const code = (body.error as string | undefined) ?? `http_${res.status}`;
  const description = (body.error_description as string | undefined) ?? `HTTP ${res.status}`;
  return { ok: false, error: makeError(code, description) };
}

/**
 * Poll for CIBA approval via POST /oauth/token grant=urn:openid:params:grant-type:ciba.
 *
 * Returns Result so the SDK never throws on known API failures. Caller can
 * branch on `result.error.code` (`ciba/authorization_pending` etc.) — the
 * canonical mapping mirrors OIDC CIBA Core §11.
 */
export async function pollCiba(
  ctx: CibaContext,
  authReqId: string,
): Promise<VerifyResult<CibaPollResponse>> {
  const params = new URLSearchParams();
  params.set('grant_type', CIBA_GRANT_TYPE);
  params.set('auth_req_id', authReqId);

  let res: Response;
  try {
    res = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(ctx.clientId, ctx.clientSecret),
      },
      body: params.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'ciba/network_error',
        message: (err as Error)?.message ?? 'Network error',
        suggestion: 'Verify Rakomi base URL is reachable.',
        docs_url: 'https://docs.rakomi.dev/oauth/ciba',
      },
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
  }

  if (res.ok) {
    const accessToken = body.access_token as string | undefined;
    const tokenType = body.token_type as string | undefined;
    const expiresIn = body.expires_in as number | undefined;
    const scope = body.scope as string | undefined;
    const idToken = body.id_token as string | undefined;
    if (
      typeof accessToken !== 'string' ||
      tokenType !== 'Bearer' ||
      typeof expiresIn !== 'number' ||
      typeof scope !== 'string'
    ) {
      return {
        ok: false,
        error: {
          code: 'ciba/malformed_response',
          message: 'Server returned 200 with body that does not match the OAuth token-response shape',
          suggestion: 'Server-side bug — file an issue.',
          docs_url: 'https://docs.rakomi.dev/oauth/ciba',
        },
      };
    }
    const out: CibaPollResponse = {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      scope,
      ...(idToken ? { idToken } : {}),
    };
    return { ok: true, data: out };
  }

  const code = (body.error as string | undefined) ?? `http_${res.status}`;
  const description = (body.error_description as string | undefined) ?? `HTTP ${res.status}`;
  return { ok: false, error: makeError(code, description) };
}

export interface CibaAwaitDecisionOptions {
  authReqId: string;
  /** Initial polling interval (ms). Server default = 5000. */
  intervalMs?: number;
  /** Optional AbortSignal — used to cancel the poll loop early. */
  signal?: AbortSignal;
}

/**
 * Poll loop. Resolves on token issuance; rejects on terminal status
 * (denied / expired / replay / abort). On `slow_down`, doubles the interval
 * up to 60s. SDK-managed in-flight guard — never issues two
 * concurrent polls for the same `authReqId`.
 */
export async function awaitCibaDecision(
  ctx: CibaContext,
  options: CibaAwaitDecisionOptions,
): Promise<CibaPollResponse> {
  let interval = Math.max(options.intervalMs ?? 5000, 1000);
  const maxInterval = 60_000;

  while (true) {
    if (options.signal?.aborted) {
      throw new CibaError('aborted', 'CIBA poll aborted');
    }
    const result: VerifyResult<CibaPollResponse> = await pollCiba(ctx, options.authReqId);

    if (result.ok) return result.data;

    const code = result.error.code.replace(/^ciba\//, '');
    switch (code) {
      case 'authorization_pending':
        await sleep(interval, options.signal);
        continue;
      case 'slow_down':
        interval = Math.min(interval + 5000, maxInterval);
        await sleep(interval, options.signal);
        continue;
      case 'access_denied':
        throw new CibaAccessDeniedError(result.error.message);
      case 'expired_token':
        throw new CibaExpiredTokenError(result.error.message);
      case 'invalid_grant':
        throw new CibaReplayError(result.error.message);
      case 'invalid_scope':
        throw new CibaInvalidScopeError(result.error.message);
      case 'unauthorized_client':
        throw new CibaUnauthorizedClientError(result.error.message);
      case 'invalid_client':
        throw new CibaInvalidClientError(result.error.message);
      case 'invalid_request':
        throw new CibaInvalidRequestError(result.error.message);
      default:
        throw new CibaError(code, result.error.message);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CibaError('aborted', 'CIBA poll aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CibaError('aborted', 'CIBA poll aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
