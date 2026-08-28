// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';

export type FetchLike = (url: string, init: RequestInit & { signal: AbortSignal }) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpDeps {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
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
  readonly error: string | { code: string; message: string; [k: string]: unknown };
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
  readonly message_localized?: string;
  readonly suggested_fix?: string;
}

function isErrorEnvelope(v: unknown): v is ErrorEnvelope {
  return typeof v === 'object' && v !== null && 'error' in v;
}

function isProblemDetails(v: unknown): v is ProblemDetailsBody {
  return typeof v === 'object' && v !== null && !('error' in v) && ('code' in v || 'detail' in v || 'title' in v);
}

/** Human-readable message from any error envelope this CLI's endpoints can return, never a stack
 * trace or internal detail. */
export function describeError(body: unknown, status: number): string {
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

/**
 * Perform one HTTP call with a hard timeout, returning the parsed JSON body regardless of status
 * (the caller decides what a given status means). Throws `CliError` ONLY for a transport-level
 * failure (network error, timeout, non-JSON body) — never for a 4xx/5xx, which is a normal,
 * typed `HttpResult`.
 */
export async function request<T = unknown>(deps: HttpDeps, req: HttpRequest): Promise<HttpResult<T>> {
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
