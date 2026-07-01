/**
 * Password reset — POST /v1/auth/forgot-password, POST /v1/auth/reset-password.
 * Always returns success-shaped response for forgot-password (email enumeration prevention).
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError } from '../types.js';
import { requiresHttpsUpgrade } from '../utils/safe-url.js';

type ForgotPasswordResult =
  | { ok: true }
  | { ok: false; error: AuthError };

type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: AuthError };

export async function sendForgotPassword(options: {
  baseUrl: string;
  email: string;
  apiKey: string;
}): Promise<ForgotPasswordResult> {
  const { baseUrl, email, apiKey } = options;

  if (requiresHttpsUpgrade(baseUrl)) {
    return { ok: false, error: { code: 'INVALID_CONFIG' as const, message: 'baseUrl must use HTTPS for non-localhost origins' } };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ email }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  if (!response.ok) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Forgot password request failed' } };
  }

  return { ok: true };
}

export async function submitResetPassword(options: {
  baseUrl: string;
  token: string;
  password: string;
  apiKey: string;
}): Promise<ResetPasswordResult> {
  const { baseUrl, token, password, apiKey } = options;

  if (requiresHttpsUpgrade(baseUrl)) {
    return { ok: false, error: { code: 'INVALID_CONFIG' as const, message: 'baseUrl must use HTTPS for non-localhost origins' } };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ token, password }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  if (!response.ok) {
    let json: unknown;
    try { json = await response.json(); } catch { }
    const body = json as { error?: { message?: string } } | undefined;
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.error?.message ?? 'Password reset failed' } };
  }

  return { ok: true };
}
