/**
 * Passkey management: list, rename, delete.
 *
 * Every call is step-up gated — changing which keys can sign you in is itself a sensitive act, so
 * the server demands a fresh re-authentication for it.
 */

import type { HttpClient } from '../types/adapters.js';
import { passkeyError } from './errors.js';
import { malformedResponseError } from './errors.js';
import { passkeyRequest, readJson } from './http.js';
import type {
  DeletePasskeyResult,
  ListPasskeysResult,
  PasskeySummary,
  PasskeySummaryResult,
} from './types.js';

const NICKNAME_MIN = 1;
const NICKNAME_MAX = 64;

interface ManagementBase {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  accessToken: string;
  stepUpToken: string;
  userId: string;
  signal?: AbortSignal;
}

export type ListPasskeysInput = ManagementBase;

export interface RenamePasskeyInput extends ManagementBase {
  passkeyId: string;
  nickname: string;
}

export interface DeletePasskeyInput extends ManagementBase {
  passkeyId: string;
}

/** List the user's registered passkeys. */
export async function listPasskeys(input: ListPasskeysInput): Promise<ListPasskeysResult> {
  const result = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/users/${encodeURIComponent(input.userId)}/passkeys`,
    clientId: input.clientId,
    method: 'GET',
    accessToken: input.accessToken,
    stepUpToken: input.stepUpToken,
    surface: 'management',
    signal: input.signal,
  });
  if (!result.ok) return { ok: false, error: result.error };

  const body = await readJson(result.response);
  const data = body?.['data'];
  if (!Array.isArray(data)) {
    return { ok: false, error: malformedResponseError('list passkeys') };
  }
  return { ok: true, data: data as PasskeySummary[] };
}

/** Rename a passkey. */
export async function renamePasskey(input: RenamePasskeyInput): Promise<PasskeySummaryResult> {
  if (input.nickname.length < NICKNAME_MIN || input.nickname.length > NICKNAME_MAX) {
    return {
      ok: false,
      error: passkeyError(
        'PASSKEY_INVALID_INPUT',
        `nickname must be between ${NICKNAME_MIN} and ${NICKNAME_MAX} characters`,
      ),
    };
  }

  const result = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/users/${encodeURIComponent(input.userId)}/passkeys/${encodeURIComponent(input.passkeyId)}`,
    clientId: input.clientId,
    method: 'PATCH',
    accessToken: input.accessToken,
    stepUpToken: input.stepUpToken,
    surface: 'management',
    signal: input.signal,
    body: { nickname: input.nickname },
  });
  if (!result.ok) return { ok: false, error: result.error };

  const body = await readJson(result.response);
  if (body === null || typeof body['id'] !== 'string') {
    return { ok: false, error: malformedResponseError('rename passkey') };
  }
  return { ok: true, passkey: body as unknown as PasskeySummary };
}

/**
 * Delete a passkey.
 *
 * The server refuses to remove the user's last remaining sign-in method — that comes back as
 * `PASSKEY_LAST_METHOD`, which a UI should turn into "add another method first", not into a generic
 * failure.
 */
export async function deletePasskey(input: DeletePasskeyInput): Promise<DeletePasskeyResult> {
  const result = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/users/${encodeURIComponent(input.userId)}/passkeys/${encodeURIComponent(input.passkeyId)}`,
    clientId: input.clientId,
    method: 'DELETE',
    accessToken: input.accessToken,
    stepUpToken: input.stepUpToken,
    surface: 'management',
    signal: input.signal,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}
