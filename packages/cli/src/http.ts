// SPDX-License-Identifier: MIT

import { buildDpopProof, canonicalizeHtu, type DpopKeyPair } from './dpop.js';
import { CliError, EXIT } from './errors.js';

export type FetchLike = (url: string, init: RequestInit & { signal: AbortSignal }) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Story cli-silent-token-refresh-and-whoami-honesty — the credentials a caller-supplied
 * `onUnauthorized()` hands back after a successful silent refresh. `accessToken` always changes on
 * a refresh; the DPoP key itself never rotates (the server's `cnf.jkt` binding stays on the SAME
 * install key across a refresh — only the token rotates), so there is no key field here — a
 * DPoP-bound retry simply keeps `req.dpop.key` and swaps `req.dpop.accessToken`.
 */
export interface RefreshedCredentials {
  readonly accessToken: string;
}

export interface HttpDeps {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  /**
   * Story cli-silent-token-refresh-and-whoami-honesty — the ONE chokepoint for silent token
   * refresh, wired ONCE at the CLI's composition root (`index.ts`'s `httpDeps`) rather than
   * threaded through every client (`tenants-client.ts`, `userinfo-client.ts`, `connect-client.ts`,
   * `billing-client.ts`, `lease-client.ts`, …) individually — see `token-refresh.ts`'s module doc
   * for the full rationale. `request()` below calls this AT MOST ONCE per logical call, and ONLY
   * when the response was a genuine 401 on an AUTHENTICATED request (a `Bearer`/`DPoP` credential
   * was actually sent — see `isAuthenticatedRequest`) — never on the DPoP §8 nonce-challenge 401,
   * which already has its own single retry above, and never on a request with no credential at all
   * (the token endpoint itself, an anonymous probe). Returns `undefined` when no refresh is
   * possible or the refresh itself failed (no `refresh_token` on the session, `invalid_grant`, a
   * network error) — `request()` then returns the ORIGINAL 401 result unchanged, and every
   * existing per-client "Your session has expired" handling fires exactly as it did before this
   * story. Never throws.
   */
  readonly onUnauthorized?: () => Promise<RefreshedCredentials | undefined>;
}

/**
 * Story rakomi-cli-dpop-token-binding — RFC 9449 DPoP proof-of-possession, threaded through the ONE
 * HTTP chokepoint (`request()` below) rather than per-call-site, so the nonce-retry logic (RFC 9449 §8)
 * has exactly ONE implementation. `accessToken` present ⇒ a resource-server call (`ath` is computed +
 * included, and `Authorization: DPoP <token>` replaces any `Bearer` header the caller would otherwise
 * build); `accessToken` absent ⇒ the token-endpoint call itself (no `ath`, no `Authorization` header —
 * the OAuth token endpoint never used one).
 */
export interface DpopRequestOptions {
  /** A `DpopKeyPair`-shaped key (a `StoredInstallKey` from `install-key.ts` satisfies this
   * structurally — same two required fields). */
  readonly key: DpopKeyPair;
  readonly accessToken?: string;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /** Sent as `application/x-www-form-urlencoded` instead of JSON (OAuth-family endpoints). */
  readonly form?: Record<string, string>;
  /** Idempotency-Key header — see `POST /v1/tenants` contract (deep dive §4 Flow B). */
  readonly idempotencyKey?: string;
  /** When present, this request is DPoP-signed — see `DpopRequestOptions`. Absent ⇒ this request is
   * strictly unaffected by this story (byte-identical to before it shipped). */
  readonly dpop?: DpopRequestOptions;
}

export interface HttpResult<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** RFC 6749 §5.2 / this repo's pre-RFC-9457 `AppError` envelope — both shapes carry a top-level `error`.
 * Used by every OAuth-family endpoint (`/oauth/*`) and every non-`/v1/*` surface — NEVER by `/v1/*`,
 * which moved to RFC 9457 `application/problem+json` (`ProblemDetailsBody` below) in story
 * `api-errors-rfc-9457-problem-details` (2026-08-26). `describeError`/`errorCode` handle BOTH shapes so
 * one helper works for every endpoint this CLI calls — `/oauth/*` (login, device grant, userinfo) and
 * `/v1/*` (tenants) alike. */
export interface ErrorEnvelope {
  readonly error: string | { code: string; message: string; request_id?: string; details?: Record<string, unknown>; [k: string]: unknown };
  readonly error_description?: string;
}

/** RFC 9457 `application/problem+json` — the `/v1/*` error shape (`code`/`detail` at the top level,
 * NO `error` key at all). */
export interface ProblemDetailsBody {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code?: string;
  /** Extension member — same request id as the `X-Request-Id` response header, repeated here.
   * `describeError` surfaces this so a user can quote it in a support ticket, matching the
   * dashboard's own error-display behaviour — see `requestIdFromError` below. */
  readonly request_id?: string;
  readonly message_localized?: string;
  readonly suggested_fix?: string;
  /** Extension member (RFC 9457 §3.2) — carries e.g. `upgrade_url` on a `plan/feature_unavailable`
   * 403 (`entitlement-guard.ts`'s `AppError(..., { upgrade_url })`). See `upsellFromProblem`. */
  readonly details?: Record<string, unknown>;
}

function isErrorEnvelope(v: unknown): v is ErrorEnvelope {
  return typeof v === 'object' && v !== null && 'error' in v;
}

function isProblemDetails(v: unknown): v is ProblemDetailsBody {
  return typeof v === 'object' && v !== null && !('error' in v) && ('code' in v || 'detail' in v || 'title' in v);
}

/** The `details` object from either error envelope shape, wherever it lives (`error.details` on the
 * RFC 6749 §5.2 envelope, `details` at the top level of an RFC 9457 problem) — or `undefined` if
 * the body carries none. Shared by `errorCode`'s siblings and `upsellFromProblem` below, never
 * re-derived per call-site. */
function errorDetails(body: unknown): Record<string, unknown> | undefined {
  if (isErrorEnvelope(body) && typeof body.error === 'object') {
    const d = body.error.details;
    return d && typeof d === 'object' ? d : undefined;
  }
  if (isProblemDetails(body)) {
    return body.details && typeof body.details === 'object' ? body.details : undefined;
  }
  return undefined;
}

/**
 * Story funnel-cli-upgrade-command-and-403-upsell — the ONE place that recognizes a plan-upsell-
 * eligible 403: status 403 AND the error's `details.upgrade_url` is a non-empty string. Deliberately
 * NOT keyed to a specific error `code` (`plan/feature_unavailable`, `organization/plan_limit_reached`,
 * …) — every upsell-eligible throw site across the API sets `details.upgrade_url` from the SAME
 * `config.PLAN_UPGRADE_URL`, and a code-keyed allow-list here would need updating every time a new
 * call-site adopts the pattern server-side. A 403 WITHOUT `upgrade_url` (e.g. `requireEntitlementLimit`'s
 * `{resource}/plan_limit_reached`, which sets `{ limit: 0 }` — no URL) never matches; neither does a
 * plain 404 or any other status. Never fabricates a "which plan unlocks this" detail — the API does
 * not return one today, so none is shown.
 */
export function upsellFromProblem(body: unknown, status: number): { readonly upgradeUrl: string } | undefined {
  if (status !== 403) return undefined;
  const url = errorDetails(body)?.upgrade_url;
  return typeof url === 'string' && url.length > 0 ? { upgradeUrl: url } : undefined;
}

/** The request id from either error envelope shape (`error.request_id` on the RFC 6749 §5.2 /
 * legacy `AppError` envelope, or the RFC 9457 top-level `request_id`) — or `undefined` if the body
 * carries none (an older API build, or a transport-level failure body that never reached the
 * server). Matches the `X-Request-Id` response header, so a user can quote either one in a
 * support ticket. */
export function requestIdFromError(body: unknown): string | undefined {
  if (isErrorEnvelope(body) && typeof body.error === 'object') {
    const id = body.error.request_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }
  if (isProblemDetails(body)) {
    return typeof body.request_id === 'string' && body.request_id.length > 0 ? body.request_id : undefined;
  }
  return undefined;
}

/** Human-readable message from any error envelope this CLI's endpoints can return, never a stack
 * trace or internal detail. When the error is plan-upsell-eligible (see `upsellFromProblem`), the
 * upgrade hint is appended here; when the body carries a `request_id` (see `requestIdFromError`),
 * a support-correlation line is appended last. This is the ONE call site every command's error
 * message already routes through, so no command has to duplicate either rendering itself. */
export function describeError(body: unknown, status: number): string {
  const base = describeErrorBase(body, status);
  const upsell = upsellFromProblem(body, status);
  const withUpsell = upsell ? `${base}\nUpgrade: ${upsell.upgradeUrl}\nRun \`rakomi upgrade\` to open this in your browser.` : base;
  const id = requestIdFromError(body);
  return id ? `${withUpsell}\nRequest ID: ${id}` : withUpsell;
}

function describeErrorBase(body: unknown, status: number): string {
  if (isErrorEnvelope(body)) {
    if (typeof body.error === 'string') return body.error_description || body.error;
    if (typeof body.error === 'object') return body.error.message || body.error.code;
  }
  if (isProblemDetails(body)) {
    return body.detail || body.title || `Request failed with HTTP ${status}`;
  }
  return `Request failed with HTTP ${status}`;
}

/** The machine error code from either envelope shape (`error.code` or RFC 9457 `code`), or
 * `undefined` if the body carries none — lets a caller branch on a SPECIFIC known code (e.g.
 * `tenant/owner_grant_requires_m2m_caller`) without re-parsing the envelope itself. */
export function errorCode(body: unknown): string | undefined {
  if (isErrorEnvelope(body) && typeof body.error === 'object') return body.error.code;
  if (isProblemDetails(body)) return body.code;
  return undefined;
}

/** One HTTP attempt — no retry logic. `dpopNonce`, when present, rides in the signed proof's `nonce`
 * claim (RFC 9449 §8 — used only by `request()`'s own retry-once below, never by a caller directly). */
async function performOnce<T>(deps: HttpDeps, req: HttpRequest, dpopNonce?: string): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    let body: string | undefined;
    if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    } else if (req.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

    if (req.dpop) {
      const proof = buildDpopProof(req.dpop.key, {
        htm: req.method,
        htu: canonicalizeHtu(req.url),
        accessToken: req.dpop.accessToken,
        nonce: dpopNonce,
      });
      headers['dpop'] = proof;
      if (req.dpop.accessToken !== undefined) {
        headers['authorization'] = `DPoP ${req.dpop.accessToken}`;
      }
    }

    let res: Response;
    try {
      res = await deps.fetchImpl(req.url, { method: req.method, headers, body, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        throw new CliError('Request timed out talking to the Rakomi API.', EXIT.FAIL);
      }
      throw new CliError('Could not reach the Rakomi API. Check your network connection.', EXIT.FAIL);
    }

    const text = await res.text();
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CliError('The Rakomi API returned a response the CLI could not understand.', EXIT.FAIL);
      }
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** `true` iff `result` is the RFC 9449 §8 server-nonce challenge shape: a 401 `auth/invalid_dpop_proof`
 * carrying a non-empty `DPoP-Nonce` response header. The internal `rfc_error:'use_dpop_nonce'` audit tag
 * is NEVER serialized into the HTTP response body — `error.code` is the SAME `auth/invalid_dpop_proof`
 * for every DPoP rejection reason, so the header is the ONLY reliable signal (verified server-side:
 * `dpop-token-binding.ts`/`error-handler.ts`). */
function isDpopNonceChallenge(result: HttpResult<unknown>): string | undefined {
  if (result.status !== 401) return undefined;
  if (errorCode(result.body) !== 'auth/invalid_dpop_proof') return undefined;
  const nonce = result.headers.get('dpop-nonce');
  return nonce && nonce.length > 0 ? nonce : undefined;
}

/** One attempt through the whole DPoP-nonce-retry machinery — extracted so `request()` below can
 * run it a SECOND time, unchanged, after a silent token refresh (see `onUnauthorized`). */
async function performWithNonceRetry<T>(deps: HttpDeps, req: HttpRequest): Promise<HttpResult<T>> {
  const first = await performOnce<T>(deps, req);
  if (!req.dpop) return first;

  const nonce = isDpopNonceChallenge(first);
  if (nonce === undefined) return first;

  const retry = await performOnce<T>(deps, req, nonce);
  if (isDpopNonceChallenge(retry) !== undefined) {
    throw new CliError(
      'The Rakomi API kept demanding a fresh DPoP nonce; the request could not complete.',
      EXIT.FAIL,
    );
  }
  return retry;
}

/** `true` iff `req` actually carries a credential — a resource-server call, never the anonymous
 * token-endpoint request itself (no `Authorization` header, `req.dpop.accessToken` absent). Only an
 * authenticated request's 401 is eligible for the silent-refresh retry — refreshing in response to,
 * say, a token-endpoint `invalid_grant` would be nonsensical. */
function isAuthenticatedRequest(req: HttpRequest): boolean {
  if (req.dpop?.accessToken !== undefined) return true;
  return typeof req.headers?.authorization === 'string' && req.headers.authorization.length > 0;
}

/** Rebuilds `req` with `credentials.accessToken` swapped in, preserving every other field — the DPoP
 * key itself (if any) is UNCHANGED (see `RefreshedCredentials`'s doc comment for why). */
function withRefreshedCredentials(req: HttpRequest, credentials: RefreshedCredentials): HttpRequest {
  if (req.dpop?.accessToken !== undefined) {
    return { ...req, dpop: { ...req.dpop, accessToken: credentials.accessToken } };
  }
  return { ...req, headers: { ...req.headers, authorization: `Bearer ${credentials.accessToken}` } };
}

/**
 * Perform one HTTP call with a hard timeout, returning the parsed JSON body regardless of status
 * (the caller decides what a given status means). Throws `CliError` ONLY for a transport-level
 * failure (network error, timeout, non-JSON body) — never for a 4xx/5xx, which is a normal,
 * typed `HttpResult`.
 *
 * Story rakomi-cli-dpop-token-binding — when `req.dpop` is present, a server RFC 9449 §8 nonce
 * challenge (`use_dpop_nonce`) is retried EXACTLY ONCE with a fresh proof carrying the challenge nonce.
 * A SECOND consecutive challenge (a persistently-demanded nonce) is not retried again — it surfaces as
 * a `CliError`, never an infinite loop. Absent `req.dpop`, this function is byte-identical to before
 * this story (no extra round trip, no new failure mode).
 *
 * Story cli-silent-token-refresh-and-whoami-honesty — a genuine 401 on an AUTHENTICATED request
 * (§ `isAuthenticatedRequest`) is retried EXACTLY ONCE via `deps.onUnauthorized()`, IFF that hook is
 * present. This is the ONE chokepoint every client (`tenants-client.ts`, `userinfo-client.ts`,
 * `connect-client.ts`, `billing-client.ts`, `lease-client.ts`, …) gets silent-refresh-then-retry
 * through — none of them changed for this story; they still throw their own "Your session has
 * expired" `CliError` on a 401 exactly as before, and now simply see that 401 less often, because it
 * already got a silent retry with a rotated token first. When `onUnauthorized()` returns
 * `undefined` (no refresh possible, or the refresh itself failed), the ORIGINAL 401 `HttpResult` is
 * returned unchanged and every existing per-client 401 branch fires exactly as before this story.
 */
export async function request<T = unknown>(deps: HttpDeps, req: HttpRequest): Promise<HttpResult<T>> {
  const first = await performWithNonceRetry<T>(deps, req);
  if (first.status !== 401) return first;
  if (!deps.onUnauthorized || !isAuthenticatedRequest(req)) return first;

  const refreshed = await deps.onUnauthorized();
  if (!refreshed) return first;

  return performWithNonceRetry<T>(deps, withRefreshedCredentials(req, refreshed));
}
