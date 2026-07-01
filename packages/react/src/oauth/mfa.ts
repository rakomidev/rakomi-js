/**
 * MFA verification — POST /v1/auth/mfa/verify-login.
 * Returns OAuthTokenResponse on successful MFA verification.
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError, OAuthTokenResponse } from '../types.js';

type MfaVerifyResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: false; error: AuthError };

/**
 * @param options.signal - Optional abort signal for caller-controlled cancellation (e.g., component unmount).
 * A 10-second timeout is always applied regardless — sdkFetch guarantees bounded execution.
 */
export async function verifyMfaLogin(options: {
  baseUrl: string;
  challengeToken: string;
  code: string;
  signal?: AbortSignal;
}): Promise<MfaVerifyResult> {
  const { baseUrl, challengeToken, code, signal } = options;

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_token: challengeToken, code }),
      signal,
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON response from MFA verify endpoint' } };
  }

  if (!response.ok) {
    const body = json as { error?: { message?: string; code?: string } };
    const message = body?.error?.message ?? 'MFA verification failed';
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message } };
  }

  const r = json as Record<string, unknown>;
  if (
    typeof r['access_token'] !== 'string' ||
    r['access_token'].length === 0 ||
    r['access_token'].length > 8192 ||
    typeof r['expires_in'] !== 'number' ||
    typeof r['token_type'] !== 'string'
  ) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid MFA verify response shape' } };
  }

  const data: OAuthTokenResponse = {
    access_token: r['access_token'],
    token_type: r['token_type'],
    expires_in: r['expires_in'],
    ...(typeof r['refresh_token'] === 'string' && r['refresh_token'].length > 0
      ? { refresh_token: r['refresh_token'] }
      : {}),
  };
  return { ok: true, data };
}
