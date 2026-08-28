/**
 * The passkey step-up leg.
 *
 * Registering or managing a passkey requires a *fresh* re-authentication, proven by a short-lived
 * step-up token. A user can mint that token with a password — or, here, with a passkey they already
 * hold.
 *
 * It runs through the same ceremony hub as sign-in and registration, so cancellation, an unsupported
 * platform, and a misbehaving adapter behave identically on all three legs.
 */

import type { HttpClient } from '../types/adapters.js';
import { getCredential, guardAdapter } from './ceremony.js';
import { malformedResponseError } from './errors.js';
import { passkeyRequest, readJson } from './http.js';
import type {
  PasskeyCeremonyAdapter,
  PublicKeyCredentialRequestOptionsJSON,
  StepUpWithPasskeyResult,
} from './types.js';

export interface StepUpWithPasskeyInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  accessToken: string;
  adapter: PasskeyCeremonyAdapter;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Mint a step-up token by asserting a passkey the user already has. */
export async function stepUpWithPasskey(input: StepUpWithPasskeyInput): Promise<StepUpWithPasskeyResult> {
  const blocked = await guardAdapter(input.adapter);
  if (blocked) return { ok: false, error: blocked };

  const options = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/auth/step-up/passkey/options`,
    clientId: input.clientId,
    accessToken: input.accessToken,
    surface: 'step-up',
    signal: input.signal,
  });
  if (!options.ok) {
    if (options.error.code === 'PASSKEY_NOT_FOUND') {
      return {
        ok: false,
        error: {
          ...options.error,
          cause: { code: 'MFA_STEP_UP_UNAVAILABLE', guidance: options.error.message },
        },
      };
    }
    return { ok: false, error: options.error };
  }

  const body = await readJson(options.response);
  if (body === null || typeof body['challenge'] !== 'string') {
    return { ok: false, error: malformedResponseError('step-up options') };
  }

  const ceremony = await getCredential({
    adapter: input.adapter,
    options: body as unknown as PublicKeyCredentialRequestOptionsJSON,
    signal: input.signal,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  if (!ceremony.ok) return { ok: false, error: ceremony.error };

  const verify = await passkeyRequest({
    http: input.http,
    url: `${input.baseUrl}/v1/auth/step-up/passkey/verify`,
    clientId: input.clientId,
    accessToken: input.accessToken,
    surface: 'step-up',
    signal: input.signal,
    body: { assertion: ceremony.credential },
  });
  if (!verify.ok) return { ok: false, error: verify.error };

  const verified = await readJson(verify.response);
  const stepUpToken = verified?.['step_up_token'];
  const expiresIn = verified?.['expires_in'];
  if (typeof stepUpToken !== 'string' || typeof expiresIn !== 'number') {
    return { ok: false, error: malformedResponseError('step-up verify') };
  }

  return { ok: true, stepUpToken, tokenType: 'StepUp', expiresIn };
}
