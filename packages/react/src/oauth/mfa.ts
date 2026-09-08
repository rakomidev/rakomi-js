/**
 * MFA verification — POST /v1/auth/mfa/verify-login.
 * Returns OAuthTokenResponse on successful MFA verification.
 *
 * Like every other `/v1/auth/*` endpoint this route requires the `X-API-Key` header, and its
 * request body field is `mfa_challenge_token` (not `challenge_token`).
 */

import { extractRequestId } from '@rakomi/sdk-core';

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
  apiKey: string;
  challengeToken: string;
  code: string;
  signal?: AbortSignal;
}): Promise<MfaVerifyResult> {
  const { baseUrl, apiKey, challengeToken, code, signal } = options;

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/mfa/verify-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ mfa_challenge_token: challengeToken, code }),
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
    const body = json as { detail?: string; request_id?: string };
    const message = body?.detail ?? 'MFA verification failed';
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message, ...(extractRequestId(body) && { requestId: extractRequestId(body) }) } };
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
