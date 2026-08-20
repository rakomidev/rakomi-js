/**
 * Shared HTTP plumbing for the passkey flows.
 *
 * Requests go through the injected `HttpClient` — never a global `fetch` — and no `*-finish` call is
 * ever retried: a WebAuthn challenge is single-use, so a transparent retry would either replay a
 * consumed challenge (a failure the caller cannot see) or burn rate-limit budget for nothing.
 */

import type { HttpClient } from '../types/adapters.js';
import { mapPasskeyHttpError, passkeyNetworkError, type PasskeySurface,readErrorBody } from './errors.js';
import type { PasskeyError } from './types.js';

export interface PasskeyRequestInput {
  http: HttpClient;
  url: string;
  clientId: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  accessToken?: string;
  stepUpToken?: string;
  surface: PasskeySurface;
  signal?: AbortSignal;
}

export type PasskeyHttpResult =
  | { ok: true; response: Response }
  | { ok: false; error: PasskeyError };

/** Send a passkey request and map any failure into the closed taxonomy. Never throws. */
export async function passkeyRequest(input: PasskeyRequestInput): Promise<PasskeyHttpResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-API-Key': input.clientId,
  };
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  if (input.accessToken !== undefined) headers['Authorization'] = `Bearer ${input.accessToken}`;
  if (input.stepUpToken !== undefined && input.surface !== 'assert') {
    headers['X-Step-Up-Token'] = input.stepUpToken;
  }

  let response: Response;
  try {
    response = await input.http.fetch(input.url, {
      method: input.method ?? 'POST',
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (err) {
    return { ok: false, error: passkeyNetworkError(err) };
  }

  if (!response.ok) {
    const body = await readErrorBody(response);
    return {
      ok: false,
      error: mapPasskeyHttpError(response.status, body, {
        surface: input.surface,
        retryAfter: response.headers?.get?.('Retry-After') ?? null,
      }),
    };
  }

  return { ok: true, response };
}

/** Parse a JSON body without ever throwing. */
export async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
