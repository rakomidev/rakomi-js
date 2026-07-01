/**
 * User registration — POST /v1/auth/register.
 * Always returns success-shaped response (email enumeration prevention).
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError } from '../types.js';
import { requiresHttpsUpgrade } from '../utils/safe-url.js';

type RegisterApiResult =
  | { ok: true }
  | { ok: false; error: AuthError };

export async function registerUser(options: {
  baseUrl: string;
  email: string;
  password: string;
  consent: boolean;
  apiKey: string;
}): Promise<RegisterApiResult> {
  const { baseUrl, email, password, consent, apiKey } = options;

  if (requiresHttpsUpgrade(baseUrl)) {
    return { ok: false, error: { code: 'INVALID_CONFIG' as const, message: 'baseUrl must use HTTPS for non-localhost origins' } };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ email, password, consent }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  if (!response.ok) {
    let json: unknown;
    try { json = await response.json(); } catch { }
    const body = json as { error?: { message?: string } } | undefined;
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.error?.message ?? 'Registration failed' } };
  }

  return { ok: true };
}
