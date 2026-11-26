/**
 * User registration — POST /v1/auth/register.
 * Always returns success-shaped response (email enumeration prevention).
 */

import { botChallengeError, extractRequestId } from '@rakomi/sdk-core';

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { AuthError } from '../types.js';
import { requiresHttpsUpgrade } from '../utils/safe-url.js';

/** `signupBinding` — the registering-browser binding of the mailed link; `<SignUp />` keeps it in
 *  `sessionStorage` and sends it with the verification token. */
type RegisterApiResult =
  | { ok: true; signupBinding?: string }
  | { ok: false; error: AuthError };

const SIGNUP_BINDING_SHAPE = /^[0-9a-f]{64}$/;

export async function registerUser(options: {
  baseUrl: string;
  email: string;
  password: string;
  consent: boolean;
  apiKey: string;
  /** Cloudflare Turnstile token, when the environment requires a bot challenge. */
  turnstileToken?: string;
}): Promise<RegisterApiResult> {
  const { baseUrl, email, password, consent, apiKey, turnstileToken } = options;

  if (requiresHttpsUpgrade(baseUrl)) {
    return { ok: false, error: { code: 'INVALID_CONFIG' as const, message: 'baseUrl must use HTTPS for non-localhost origins' } };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ email, password, consent, ...(turnstileToken ? { turnstile_token: turnstileToken } : {}) }),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  if (!response.ok) {
    let json: unknown;
    try { json = await response.json(); } catch { }
    const challenge = botChallengeError(json);
    if (challenge) return { ok: false, error: challenge };
    const body = json as { detail?: string; request_id?: string } | undefined;
    return { ok: false, error: { code: 'SIGN_IN_FAILED' as const, message: body?.detail ?? 'Registration failed', ...(extractRequestId(body) && { requestId: extractRequestId(body) }) } };
  }

  try {
    const body = (await response.json()) as { signup_binding?: unknown };
    const binding = body?.signup_binding;
    if (typeof binding === 'string' && SIGNUP_BINDING_SHAPE.test(binding)) return { ok: true, signupBinding: binding };
  } catch { }
  return { ok: true };
}
