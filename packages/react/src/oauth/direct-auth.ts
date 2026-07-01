/**
 * Direct auth mode: sign in via POST /v1/auth/login.
 * No OAuth redirect — developer provides email/password directly.
 * Returns OAuthTokenResponse shape for unified token handling.
 *
 * All fetch calls use credentials: 'omit'.
 * HTTPS enforcement: rejects http:// baseUrl on non-localhost.
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError,OAuthTokenResponse } from '../types.js';

const LOCALHOST_ORIGINS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOCALHOST_ORIGINS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export type DirectSignInResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: true; nextStep: 'mfa_challenge'; challengeToken: string; expiresIn: number }
  | { ok: true; nextStep: 'mfa_setup_required'; graceDeadlineAt: string }
  | { ok: false; error: AuthError };

/**
 * Sign in directly via /v1/auth/login (email + password).
 * Returns the token response on success.
 *
 * Throws SdkError for HTTPS violations (http:// on non-localhost).
 */
export async function directSignIn(options: {
  baseUrl: string;
  email: string;
  password: string;
  apiKey?: string;
}): Promise<DirectSignInResult> {
  const { baseUrl, email, password, apiKey } = options;

  if (baseUrl.startsWith('http://') && !isLocalhost(baseUrl)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_CONFIG' as const,
        message: 'baseUrl must use HTTPS for non-localhost origins. Sending credentials over cleartext is prohibited.',
      },
    };
  }

  let response: Response;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;

    response = await sdkFetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON response from login endpoint' } };
  }

  if (response.status === 401 || response.status === 400) {
    const body = json as { error?: { message?: string } };
    const message = body?.error?.message ?? 'Invalid email or password';
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message } };
  }

  if (!response.ok) {
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: `Login failed with status ${response.status}` } };
  }

  const r = json as Record<string, unknown>;

  if (r['next_step'] === 'mfa_challenge') {
    if (typeof r['mfa_challenge_token'] !== 'string' || r['mfa_challenge_token'].length === 0) {
      return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'MFA challenge token missing from API response' } };
    }
    return {
      ok: true,
      nextStep: 'mfa_challenge',
      challengeToken: r['mfa_challenge_token'],
      expiresIn: typeof r['mfa_expires_in'] === 'number' ? r['mfa_expires_in'] : 300,
    };
  }

  if (r['next_step'] === 'mfa_setup_required') {
    return {
      ok: true,
      nextStep: 'mfa_setup_required',
      graceDeadlineAt: typeof r['grace_deadline_at'] === 'string' ? r['grace_deadline_at'] : '',
    };
  }

  if (
    typeof r['access_token'] !== 'string' ||
    r['access_token'].length === 0 ||
    r['access_token'].length > 8192 ||
    typeof r['expires_in'] !== 'number' ||
    typeof r['token_type'] !== 'string'
  ) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid login response shape' } };
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
