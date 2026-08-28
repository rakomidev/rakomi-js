/**
 * Passkey error mapping — ONE place, nine endpoints.
 *
 * Every HTTP failure across register / assert / step-up / management resolves here, so a mapping
 * fix can never land in some call sites and miss others.
 */

import type { PasskeyError, PasskeyErrorCode, PasskeyNextAction } from './types.js';

/** Which flow the failing call belongs to — the same status means different things per surface. */
export type PasskeySurface = 'register' | 'assert' | 'step-up' | 'management';

export interface ApiErrorBody {
  code?: string;
  detail?: string;
}

const NEXT_ACTION: Record<PasskeyErrorCode, PasskeyNextAction> = {
  PASSKEY_NOT_SUPPORTED: 'abort',
  PASSKEY_CEREMONY_CANCELLED: 'retry',
  PASSKEY_CEREMONY_FAILED: 'retry',
  PASSKEY_ADAPTER_ERROR: 'abort',
  PASSKEY_STEP_UP_REQUIRED: 'step-up',
  PASSKEY_ALREADY_REGISTERED: 'abort',
  PASSKEY_FINISH_FAILED: 'retry',
  PASSKEY_ADDITIONAL_STEP_REQUIRED: 'none',
  PASSKEY_RATE_LIMITED: 'backoff',
  PASSKEY_BLOCKED: 'abort',
  PASSKEY_DISABLED: 'abort',
  PASSKEY_NOT_FOUND: 'abort',
  PASSKEY_LAST_METHOD: 'abort',
  PASSKEY_INVALID_INPUT: 'abort',
  PASSKEY_CREDENTIAL_UNUSABLE: 'abort',
  PASSKEY_SIGN_IN_FAILED: 'retry',
  PASSKEY_SESSION_EXPIRED: 'abort',
  PASSKEY_REQUEST_FAILED: 'retry',
  PASSKEY_NETWORK_ERROR: 'retry',
};

/** Build a typed passkey error with its declarative `nextAction` attached. */
export function passkeyError(
  code: PasskeyErrorCode,
  message: string,
  extra?: { retryAfterMs?: number; nextStep?: string },
): PasskeyError {
  const error: PasskeyError = { code, message, nextAction: NEXT_ACTION[code] };
  if (extra?.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  if (extra?.nextStep !== undefined) error.nextStep = extra.nextStep;
  return error;
}

/**
 * Parse a `Retry-After` header (RFC 9110 §10.2.3) into milliseconds.
 *
 * Both forms are accepted: delta-seconds and an HTTP-date. An absent or unparseable header yields
 * `undefined` — the SDK never invents a backoff, because a fabricated one is worse than none: every
 * client would wake up at the same moment and retry in lockstep.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  if (value === '') return undefined;

  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }

  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return undefined;
  const delta = asDate - now;
  return delta > 0 ? delta : 0;
}

/**
 * Map an HTTP failure to the closed passkey taxonomy.
 *
 * The 401 branch is the sharp edge: on a step-up-gated endpoint two different 401s are reachable —
 * a step-up demand and an ordinary expired access token. They are told apart by the **error code in
 * the body**, never by the status alone; mapping every 401 to "step up" would send an integrator
 * into an endless step-up loop against a session that has simply expired.
 */
export function mapPasskeyHttpError(
  status: number,
  body: ApiErrorBody,
  ctx: { surface: PasskeySurface; retryAfter?: string | null; now?: number },
): PasskeyError {
  const apiCode = body.code ?? '';
  const apiMessage = body.detail ?? `request failed (${status})`;

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(ctx.retryAfter, ctx.now ?? Date.now());
    return passkeyError('PASSKEY_RATE_LIMITED', apiMessage, retryAfterMs === undefined ? undefined : { retryAfterMs });
  }

  if (status === 401) {
    if (apiCode === 'passkey/invalid_rp_id' || apiCode === 'passkey/unknown_credential') {
      return passkeyError('PASSKEY_CREDENTIAL_UNUSABLE', apiMessage);
    }
    if (apiCode === 'passkey/step_up_required') {
      return passkeyError('PASSKEY_STEP_UP_REQUIRED', apiMessage);
    }
    if (ctx.surface === 'assert' || apiCode.startsWith('passkey/')) {
      return passkeyError('PASSKEY_SIGN_IN_FAILED', apiMessage);
    }
    return passkeyError('PASSKEY_SESSION_EXPIRED', apiMessage);
  }

  if (status === 403) {
    return passkeyError('PASSKEY_BLOCKED', apiMessage);
  }

  if (status === 404) {
    if (apiCode === 'passkey/not_found') {
      return passkeyError('PASSKEY_NOT_FOUND', apiMessage);
    }
    return passkeyError('PASSKEY_DISABLED', apiMessage);
  }

  if (status === 409) {
    if (apiCode === 'passkey/cannot_delete_last_method') {
      return passkeyError('PASSKEY_LAST_METHOD', apiMessage);
    }
    return passkeyError('PASSKEY_ALREADY_REGISTERED', apiMessage);
  }

  if (status === 400 && ctx.surface === 'step-up') {
    return passkeyError('PASSKEY_NOT_FOUND', apiMessage);
  }

  return passkeyError(
    ctx.surface === 'assert' ? 'PASSKEY_SIGN_IN_FAILED' : 'PASSKEY_REQUEST_FAILED',
    apiMessage,
  );
}

/** Read an API error body without ever throwing. */
export async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}

/** The request never reached the server. */
export function passkeyNetworkError(err: unknown): PasskeyError {
  return passkeyError('PASSKEY_NETWORK_ERROR', err instanceof Error ? err.message : 'fetch failed');
}

/** The server answered, but the payload was not the shape the contract promises. */
export function malformedResponseError(what: string): PasskeyError {
  return passkeyError('PASSKEY_REQUEST_FAILED', `${what} response malformed`);
}
