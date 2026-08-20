/**
 * Passkey sign-in: begin → ceremony → finish.
 *
 * This is the pre-authentication entry path — it issues a session rather than consuming one, so it
 * carries no `Authorization` and no step-up token.
 */

import type { HttpClient } from '../types/adapters.js';
import { getCredential, guardAdapter } from './ceremony.js';
import { malformedResponseError, passkeyError } from './errors.js';
import { passkeyRequest, readJson } from './http.js';
import type {
  AssertPasskeyResult,
  OpaqueUserHandle,
  PasskeyCeremonyAdapter,
  PasskeyTokens,
  PublicKeyCredentialRequestOptionsJSON,
} from './types.js';

export interface AssertPasskeyInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  adapter: PasskeyCeremonyAdapter;
  /**
   * Identified sign-in. Omit it for the usernameless flow, where the authenticator picks the
   * credential. It is an opaque server-issued handle — never an email or username.
   */
  userHandle?: OpaqueUserHandle;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Sign in with a passkey. Returns the token bundle on success. */
export async function assertPasskey(input: AssertPasskeyInput): Promise<AssertPasskeyResult> {
  const blocked = await guardAdapter(input.adapter);
  if (blocked) return { ok: false, error: blocked };

  const handle = input.userHandle !== undefined && input.userHandle !== '' ? input.userHandle : undefined;

  const begin = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/passkeys/assert-begin`,
    clientId: input.clientId,
    surface: 'assert',
    signal: input.signal,
    body: handle === undefined ? {} : { user_handle: handle },
  });
  if (!begin.ok) return { ok: false, error: begin.error };

  const options = await readJson(begin.response);
  if (options === null) {
    return { ok: false, error: malformedResponseError('assert-begin') };
  }

  const ceremony = await getCredential({
    adapter: input.adapter,
    options: options as unknown as PublicKeyCredentialRequestOptionsJSON,
    signal: input.signal,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  if (!ceremony.ok) return { ok: false, error: ceremony.error };

  const finish = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/passkeys/assert-finish`,
    clientId: input.clientId,
    surface: 'assert',
    signal: input.signal,
    body: { response: ceremony.credential },
  });
  if (!finish.ok) return { ok: false, error: finish.error };

  const body = await readJson(finish.response);
  if (body === null) {
    return { ok: false, error: malformedResponseError('assert-finish') };
  }

  const nextStep = body['next_step'];
  if (typeof nextStep === 'string' && nextStep !== 'authenticated') {
    return {
      ok: false,
      error: passkeyError('PASSKEY_ADDITIONAL_STEP_REQUIRED', 'an additional authentication step is required', {
        nextStep,
      }),
    };
  }

  const accessToken = body['access_token'];
  const expiresIn = body['expires_in'];
  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
    return { ok: false, error: malformedResponseError('assert-finish') };
  }

  const tokens: PasskeyTokens = {
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: typeof body['token_type'] === 'string' ? (body['token_type'] as string) : 'Bearer',
    ...(typeof body['refresh_token'] === 'string' ? { refresh_token: body['refresh_token'] as string } : {}),
  };

  return { ok: true, tokens };
}
