/**
 * Email OTP auth — POST /v1/auth/email-otp, POST /v1/auth/email-otp/verify.
 * Send OTP code via email and verify codes.
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError, OAuthTokenResponse } from '../types.js';
import { requiresHttpsUpgrade } from '../utils/safe-url.js';

type SendEmailOtpResult =
  | { ok: true; resendAfterSeconds: number; expiresAt: string }
  | { ok: false; error: AuthError };

type VerifyEmailOtpResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: true; nextStep: 'mfa_challenge'; challengeToken: string; expiresIn: number }
  | { ok: false; error: AuthError };

export async function sendEmailOtp(options: {
  baseUrl: string;
  email: string;
  apiKey: string;
}): Promise<SendEmailOtpResult> {
  const { baseUrl, email, apiKey } = options;

  if (requiresHttpsUpgrade(baseUrl)) {
    return { ok: false, error: { code: 'INVALID_CONFIG' as const, message: 'baseUrl must use HTTPS for non-localhost origins' } };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/email-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ email }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON response' } };
  }

  if (!response.ok) {
    const body = json as { error?: { message?: string } };
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.error?.message ?? 'Email OTP request failed' } };
  }

  const r = json as Record<string, unknown>;
  return {
    ok: true,
    resendAfterSeconds: typeof r['resend_after_seconds'] === 'number' ? r['resend_after_seconds'] : 60,
    expiresAt: typeof r['expires_at'] === 'string' ? r['expires_at'] : new Date(Date.now() + 600_000).toISOString(),
  };
}

/**
 * @param options.signal - Optional abort signal for caller-controlled cancellation (e.g., component unmount).
 * A 10-second timeout is always applied regardless — sdkFetch guarantees bounded execution.
 */
export async function verifyEmailOtpCode(options: {
  baseUrl: string;
  email: string;
  code: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<VerifyEmailOtpResult> {
  const { baseUrl, email, code, apiKey, signal } = options;

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/email-otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ email, code }),
      signal,
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON response from OTP verify' } };
  }

  if (!response.ok) {
    const body = json as { error?: { message?: string } };
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.error?.message ?? 'Email OTP verification failed' } };
  }

  const r = json as Record<string, unknown>;

  if (r['next_step'] === 'mfa_challenge') {
    const challengeToken = typeof r['mfa_challenge_token'] === 'string' ? r['mfa_challenge_token'] : '';
    if (!challengeToken) {
      return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Missing MFA challenge token in OTP verify response' } };
    }
    return {
      ok: true,
      nextStep: 'mfa_challenge',
      challengeToken,
      expiresIn: typeof r['mfa_expires_in'] === 'number' ? r['mfa_expires_in'] : 300,
    };
  }

  if (
    typeof r['access_token'] !== 'string' ||
    r['access_token'].length === 0 ||
    r['access_token'].length > 8192 ||
    typeof r['expires_in'] !== 'number' ||
    typeof r['token_type'] !== 'string'
  ) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid OTP verify response shape' } };
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
