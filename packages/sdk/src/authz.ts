/**
 * Node SDK surface for the platform's experimental AuthZEN PDP-fronting endpoints
 * (`/access/v1/*` + `/.well-known/authzen-configuration`).
 *
 * **THIN TRANSPORT WRAPPER ONLY — no decision logic lives here.** Every method is a typed HTTP call to
 * an endpoint Rakomi's API already computes the authorization decision for; this class only shapes the
 * request/response and maps HTTP status codes to typed errors.
 *
 * **EXPERIMENTAL.** Rakomi implements a SUBSET of the AuthZEN Authorization API 1.0 (Final
 * Specification): single evaluation, batch evaluation, and action search. Subject Search and Resource
 * Search are NOT implemented. These endpoints are subject to change before GA — this is never a
 * standards-certified or fully-conformant AuthZEN implementation. See
 * https://docs.rakomi.dev/guides/authzen-pdp for the full request/response shapes, the experimental
 * status, and which parts of the spec are and are not covered.
 *
 * These endpoints authenticate via bearer JWT — an end-user token OR an M2M/agent token, carrying the
 * `authz:evaluate` scope — passed per call as `accessToken`. This is NOT the SDK client's own API key:
 * the platform's AuthZEN routes verify a JWT (the same chokepoint every other bearer-scoped `/v1`-style
 * route uses), a different authentication path than the API-key auth `RakomiClient.flags` /
 * `RakomiClient.credentials` use. The endpoints are also feature-gated (`AUTHZEN_PDP_ENABLED`) and
 * return a uniform 404 when disabled — mapped here to a typed `authz/disabled` error, since a 404 from
 * this surface means "the flag is off", never "unknown route".
 *
 * Kept dependency-free by design (mirrors {@link ./agents.js} / {@link ./link.js}): types and error
 * shapes are maintained LOCALLY rather than imported from an internal package, since this package ships
 * with zero runtime dependencies beyond `jose`.
 */

import type { SdkError, VerifyResult } from './types.js';

export interface AuthzenSubject {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

export interface AuthzenResource {
  type: string;
  id: string;
  properties?: Record<string, unknown>;
}

export interface AuthzenAction {
  name: string;
  properties?: Record<string, unknown>;
}

export interface AuthzEvaluationResult {
  decision: boolean;
  context?: Record<string, unknown>;
}

export interface AuthzBatchEvaluationItem {
  subject?: AuthzenSubject;
  resource?: AuthzenResource;
  action?: AuthzenAction;
  context?: Record<string, unknown>;
}

export interface AuthzBatchEvaluationResult {
  evaluations: AuthzEvaluationResult[];
}

export interface AuthzSearchPage {
  token?: string;
  limit?: number;
  properties?: Record<string, unknown>;
}

export interface AuthzSearchActionResult {
  results: Array<{ name: string }>;
}

/**
 * PDP discovery metadata (RFC 8615 `/.well-known/authzen-configuration`). `[key: string]: unknown`
 * covers the base spec's own passthrough extension point (e.g. Rakomi's `rakomi_coaz_mcp_binding`
 * field, present only when that extension is enabled) — never assume the field set is closed.
 */
export interface AuthzDiscoveryDocument {
  policy_decision_point: string;
  access_evaluation_endpoint: string;
  access_evaluations_endpoint?: string;
  search_action_endpoint?: string;
  [key: string]: unknown;
}

export interface AuthzClientContext {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface AuthzCallOptions {
  /**
   * Bearer JWT carrying `authz:evaluate` — an end-user token OR an M2M/agent token. NOT the SDK
   * client's own API key.
   */
  accessToken: string;
}

export interface AuthzEvaluateOptions extends AuthzCallOptions {
  subject: AuthzenSubject;
  resource: AuthzenResource;
  action: AuthzenAction;
  context?: Record<string, unknown>;
}

export interface AuthzEvaluateBatchOptions extends AuthzCallOptions {
  /** Up to 20 boxcarred items per call (the endpoint's documented cap; a larger array is refused). */
  evaluations: AuthzBatchEvaluationItem[];
  /** Optional top-level defaults — inherited per-field by any `evaluations[]` item that omits it. */
  subject?: AuthzenSubject;
  resource?: AuthzenResource;
  action?: AuthzenAction;
  context?: Record<string, unknown>;
}

export interface AuthzSearchActionsOptions extends AuthzCallOptions {
  subject: AuthzenSubject;
  resource: AuthzenResource;
  context?: Record<string, unknown>;
  page?: AuthzSearchPage;
}

export class AuthzNetworkError extends Error {
  readonly code = 'authz/network_error';
  constructor(message: string) {
    super(message);
    this.name = 'AuthzNetworkError';
  }
}

export class AuthzUnauthorizedError extends Error {
  readonly code = 'authz/unauthorized';
  constructor(message = 'Missing or invalid access token') {
    super(message);
    this.name = 'AuthzUnauthorizedError';
  }
}

export class AuthzForbiddenError extends Error {
  readonly code = 'authz/forbidden';
  constructor(message = 'Access token missing the authz:evaluate scope') {
    super(message);
    this.name = 'AuthzForbiddenError';
  }
}

export class AuthzDisabledError extends Error {
  readonly code = 'authz/disabled';
  constructor(message = 'AuthZEN PDP endpoints are disabled in this environment') {
    super(message);
    this.name = 'AuthzDisabledError';
  }
}

export class AuthzInvalidRequestError extends Error {
  readonly code = 'authz/invalid_request';
  constructor(message: string) {
    super(message);
    this.name = 'AuthzInvalidRequestError';
  }
}

export class AuthzPayloadTooLargeError extends Error {
  readonly code = 'authz/payload_too_large';
  constructor(message = "Request body exceeds the endpoint's documented size limit") {
    super(message);
    this.name = 'AuthzPayloadTooLargeError';
  }
}

export class AuthzRateLimitedError extends Error {
  readonly code = 'authz/rate_limited';
  readonly retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number) {
    super('Rate limit exceeded for an AuthZEN PDP endpoint');
    this.name = 'AuthzRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** RFC 9457 `application/problem+json` — `code`/`detail` at the top level (same convention as
 * agents.ts / link.ts). `message` is also read defensively — this endpoint family's own 400 body
 * (`AppError`) uses `{ error: { code, message } }`, but the response is read leniently either way. */
interface ApiErrorBody {
  code?: string;
  detail?: string;
  message?: string;
  error?: { code?: string; message?: string };
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return undefined;
}

const DOCS_URL = 'https://docs.rakomi.dev/guides/authzen-pdp';

function networkError(message: string): SdkError {
  return {
    code: 'authz/network_error',
    message,
    suggestion: 'Verify the Rakomi base URL is reachable and that DNS / TLS is healthy.',
    docs_url: DOCS_URL,
  };
}

function unauthorizedError(): SdkError {
  return {
    code: 'authz/unauthorized',
    message: 'Missing or invalid access token',
    suggestion: 'Pass a valid bearer JWT (end-user or M2M/agent token) in `accessToken`.',
    docs_url: DOCS_URL,
  };
}

function forbiddenError(): SdkError {
  return {
    code: 'authz/forbidden',
    message: 'Access token missing the authz:evaluate scope',
    suggestion: 'Grant the calling token the `authz:evaluate` scope.',
    docs_url: DOCS_URL,
  };
}

function disabledError(): SdkError {
  return {
    code: 'authz/disabled',
    message: 'AuthZEN PDP endpoints are disabled in this environment (AUTHZEN_PDP_ENABLED off)',
    suggestion: 'These endpoints are experimental and gated per environment — confirm availability with Rakomi before relying on them.',
    docs_url: DOCS_URL,
  };
}

function invalidRequestError(message: string): SdkError {
  return {
    code: 'authz/invalid_request',
    message,
    suggestion: 'Every evaluations[] item must resolve a subject, resource and action — either on the item itself or via a top-level default.',
    docs_url: DOCS_URL,
  };
}

function payloadTooLargeError(): SdkError {
  return {
    code: 'authz/payload_too_large',
    message: "Request body exceeds the endpoint's documented size limit",
    suggestion: 'Reduce the number of boxcarred evaluations[] items, or the size of subject/resource/action properties.',
    docs_url: DOCS_URL,
  };
}

function rateLimitedError(retryAfter?: number): SdkError {
  return {
    code: 'authz/rate_limited',
    message: 'Rate limit exceeded for an AuthZEN PDP endpoint',
    suggestion: retryAfter !== undefined ? `Wait ${retryAfter}s and retry.` : 'Slow down and retry after a short back-off.',
    docs_url: DOCS_URL,
  };
}

function genericError(status: number, body: ApiErrorBody | null): SdkError {
  return {
    code: body?.code ?? body?.error?.code ?? `authz/http_${status}`,
    message: body?.detail ?? body?.message ?? body?.error?.message ?? `HTTP ${status}`,
    suggestion: 'Inspect the response body and retry if appropriate.',
    docs_url: DOCS_URL,
  };
}

/** Shared non-2xx status -> typed-error mapping for the three POST evaluation-shaped endpoints. */
async function mapEvaluationError(res: Response): Promise<SdkError> {
  if (res.status === 401) return unauthorizedError();
  if (res.status === 403) return forbiddenError();
  if (res.status === 404) return disabledError();
  if (res.status === 413) return payloadTooLargeError();
  if (res.status === 429) return rateLimitedError(parseRetryAfter(res));
  if (res.status === 400) {
    const body = await safeJson<ApiErrorBody>(res);
    return invalidRequestError(body?.detail ?? body?.message ?? body?.error?.message ?? 'Malformed request body');
  }
  const body = await safeJson<ApiErrorBody>(res);
  return genericError(res.status, body);
}

/**
 * Thin PDP-client for the AuthZEN Authorization API 1.0 subset endpoints. Attached to
 * `RakomiClient#authz`. See the module doc comment above for the experimental-status and
 * transport-only-wrapper caveats.
 *
 * SSRF hardening: every `fetch` sets `redirect: 'error'` (same posture as `AgentsClient`/`LinkClient`).
 */
export class AuthzClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(ctx: AuthzClientContext) {
    this.baseUrl = ctx.baseUrl;
    this.fetchImpl = ctx.fetchImpl ?? fetch;
  }

  /** POST /access/v1/evaluation — single Access Evaluation decision. */
  async evaluate(options: AuthzEvaluateOptions): Promise<VerifyResult<AuthzEvaluationResult>> {
    const { accessToken, ...body } = options;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/access/v1/evaluation`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: networkError(err instanceof Error ? err.message : 'Network error') };
    }

    if (res.status === 200) {
      const parsed = await safeJson<AuthzEvaluationResult>(res);
      if (!parsed || typeof parsed.decision !== 'boolean') {
        return { ok: false, error: networkError('Malformed response body — expected { decision: boolean }') };
      }
      return { ok: true, data: parsed };
    }

    return { ok: false, error: await mapEvaluationError(res) };
  }

  /** POST /access/v1/evaluations — batch (boxcarred) Access Evaluations, up to 20 items per call.
   * Always executed with `execute_all` semantics server-side regardless of any `options` passed. */
  async evaluateBatch(options: AuthzEvaluateBatchOptions): Promise<VerifyResult<AuthzBatchEvaluationResult>> {
    const { accessToken, ...body } = options;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/access/v1/evaluations`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: networkError(err instanceof Error ? err.message : 'Network error') };
    }

    if (res.status === 200) {
      const parsed = await safeJson<AuthzBatchEvaluationResult>(res);
      if (!parsed || !Array.isArray(parsed.evaluations)) {
        return { ok: false, error: networkError('Malformed response body — expected { evaluations: [...] }') };
      }
      return { ok: true, data: parsed };
    }

    return { ok: false, error: await mapEvaluationError(res) };
  }

  /** POST /access/v1/search/action — which action names `subject` may perform on `resource`.
   * The entitlement axis is not supported by this endpoint (returns an empty result, never an error). */
  async searchActions(options: AuthzSearchActionsOptions): Promise<VerifyResult<AuthzSearchActionResult>> {
    const { accessToken, ...body } = options;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/access/v1/search/action`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: networkError(err instanceof Error ? err.message : 'Network error') };
    }

    if (res.status === 200) {
      const parsed = await safeJson<AuthzSearchActionResult>(res);
      if (!parsed || !Array.isArray(parsed.results)) {
        return { ok: false, error: networkError('Malformed response body — expected { results: [...] }') };
      }
      return { ok: true, data: parsed };
    }

    return { ok: false, error: await mapEvaluationError(res) };
  }

  /**
   * GET /.well-known/authzen-configuration — PDP discovery metadata (RFC 8615). Public,
   * unauthenticated — no `accessToken` needed. Not cached by this method: the document is boot-time
   * constant server-side, so a caller that polls this frequently should cache the result itself
   * (this is a thin transport wrapper, not a caching layer).
   */
  async discover(): Promise<VerifyResult<AuthzDiscoveryDocument>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/.well-known/authzen-configuration`, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      return { ok: false, error: networkError(err instanceof Error ? err.message : 'Network error') };
    }

    if (res.status === 200) {
      const parsed = await safeJson<AuthzDiscoveryDocument>(res);
      if (!parsed || typeof parsed.policy_decision_point !== 'string' || typeof parsed.access_evaluation_endpoint !== 'string') {
        return { ok: false, error: networkError('Malformed response body — expected policy_decision_point + access_evaluation_endpoint') };
      }
      return { ok: true, data: parsed };
    }

    if (res.status === 404) return { ok: false, error: disabledError() };
    const body = await safeJson<ApiErrorBody>(res);
    return { ok: false, error: genericError(res.status, body) };
  }
}
