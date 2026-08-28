/**
 * Passkey registration: begin → ceremony → finish.
 *
 * Both legs are step-up gated. That matters more than it looks: a step-up token that was valid at
 * `register-begin` can expire while the user is hunting for their security key, so `register-finish`
 * can demand a step-up the caller believed it already had.
 */

import type { HttpClient } from '../types/adapters.js';
import { createCredential } from './ceremony.js';
import { guardAdapter } from './ceremony.js';
import { malformedResponseError, passkeyError } from './errors.js';
import { passkeyRequest, readJson } from './http.js';
import type {
  PasskeyCeremonyAdapter,
  PublicKeyCredentialCreationOptionsJSON,
  RegisterPasskeyResult,
} from './types.js';

const NICKNAME_MIN = 1;
const NICKNAME_MAX = 64;

export interface RegisterPasskeyInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  accessToken: string;
  /** Minted by `stepUpWithPasskey` or by the password step-up endpoint. */
  stepUpToken: string;
  adapter: PasskeyCeremonyAdapter;
  nickname?: string;
  signal?: AbortSignal;
  /** Overrides the ceremony time budget. Tests use this; applications should not need it. */
  timeoutMs?: number;
}

/**
 * Register a new passkey for the signed-in user.
 *
 * On failure after the authenticator has already minted a credential, the result carries
 * `ceremonyCompleted: true` — the caller can then tell "the user did nothing" apart from "the user
 * touched their key and the server rejected it", which is the difference between offering a retry
 * and explaining an orphaned credential.
 */
export async function registerPasskey(input: RegisterPasskeyInput): Promise<RegisterPasskeyResult> {
  if (input.nickname !== undefined) {
    const length = input.nickname.length;
    if (length < NICKNAME_MIN || length > NICKNAME_MAX) {
      return {
        ok: false,
        error: passkeyError(
          'PASSKEY_INVALID_INPUT',
          `nickname must be between ${NICKNAME_MIN} and ${NICKNAME_MAX} characters`,
        ),
      };
    }
  }

  const blocked = await guardAdapter(input.adapter);
  if (blocked) return { ok: false, error: blocked };

  const begin = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/passkeys/register-begin`,
    clientId: input.clientId,
    accessToken: input.accessToken,
    stepUpToken: input.stepUpToken,
    surface: 'register',
    signal: input.signal,
  });
  if (!begin.ok) return { ok: false, error: begin.error };

  const options = await readJson(begin.response);
  if (options === null) {
    return { ok: false, error: malformedResponseError('register-begin') };
  }

  const ceremony = await createCredential({
    adapter: input.adapter,
    options: options as unknown as PublicKeyCredentialCreationOptionsJSON,
    signal: input.signal,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  if (!ceremony.ok) return { ok: false, error: ceremony.error };

  const finish = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/passkeys/register-finish`,
    clientId: input.clientId,
    accessToken: input.accessToken,
    stepUpToken: input.stepUpToken,
    surface: 'register',
    signal: input.signal,
    body: {
      response: ceremony.credential,
      ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
    },
  });
  if (!finish.ok) {
    const error =
      finish.error.code === 'PASSKEY_ALREADY_REGISTERED' ||
      finish.error.code === 'PASSKEY_STEP_UP_REQUIRED'
        ? finish.error
        : passkeyError('PASSKEY_FINISH_FAILED', finish.error.message);
    return { ok: false, error, ceremonyCompleted: true };
  }

  const body = await readJson(finish.response);
  const passkeyId = body?.['passkey_id'];
  if (typeof passkeyId !== 'string') {
    return {
      ok: false,
      error: malformedResponseError('register-finish'),
      ceremonyCompleted: true,
    };
  }

  return { ok: true, passkeyId };
}
