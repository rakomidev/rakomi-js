/**
 * Magic link auth — POST /v1/auth/magic-link, POST /v1/auth/magic-link/verify.
 * Send magic link email and verify tokens from email links.
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError, OAuthTokenResponse } from '../types.js';
import { requiresHttpsUpgrade } from '../utils/safe-url.js';

type SendMagicLinkResult =
  | { ok: true; resendAfterSeconds: number }
  | { ok: false; error: AuthError };

type VerifyMagicLinkResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: true; nextStep: 'mfa_challenge'; challengeToken: string; expiresIn: number }
  | { ok: false; error: AuthError };

export async function sendMagicLink(options: {
  baseUrl: string;
  email: string;
  apiKey: string;
}): Promise<SendMagicLinkResult> {
  const { baseUrl, email, apiKey } = options;

  if (requiresHttpsUpgrade(baseUrl)) {
    return { ok: false, error: { code: 'INVALID_CONFIG' as const, message: 'baseUrl must use HTTPS for non-localhost origins' } };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/magic-link`, {
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
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.error?.message ?? 'Magic link request failed' } };
  }

  const r = json as Record<string, unknown>;
  const resendAfterSeconds = typeof r['resend_after_seconds'] === 'number' ? r['resend_after_seconds'] : 60;
  return { ok: true, resendAfterSeconds };
}

export async function verifyMagicLinkToken(options: {
  baseUrl: string;
  token: string;
  apiKey: string;
  /** Optional caller-controlled AbortSignal for unmount cancellation */
  signal?: AbortSignal;
}): Promise<VerifyMagicLinkResult> {
  const { baseUrl, token, apiKey, signal: callerSignal } = options;

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ token }),
      signal: callerSignal,
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON response from magic link verify' } };
  }

  if (!response.ok) {
    const body = json as { error?: { message?: string } };
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.error?.message ?? 'Magic link verification failed' } };
  }

  const r = json as Record<string, unknown>;

  if (r['next_step'] === 'mfa_challenge') {
    const challengeToken = typeof r['mfa_challenge_token'] === 'string' ? r['mfa_challenge_token'] : '';
    if (!challengeToken) {
      return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Missing MFA challenge token in magic link verify response' } };
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
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid magic link verify response shape' } };
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
