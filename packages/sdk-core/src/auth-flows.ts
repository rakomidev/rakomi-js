/**
 * Direct-auth helpers.
 *
 * Platform-neutral wrappers around the Rakomi authn endpoints:
 * - POST /v1/auth/magic-link
 * - POST /v1/auth/magic-link/verify
 * - POST /v1/auth/email-otp
 * - POST /v1/auth/email-otp/verify
 * - POST /v1/auth/register
 * - POST /v1/auth/login
 * - POST /v1/auth/forgot-password
 * - POST /v1/auth/verify-email
 * - POST /v1/auth/resend-verification
 *
 * Both magic-link and email-otp verify endpoints can return either a token bundle
 * directly or an OAuth `code` to be exchanged via `/oauth/token`. Callers normalise
 * via the discriminated `MagicLinkVerifyResult` / `EmailOtpVerifyResult` shapes.
 */

import { botChallengeError, type BotChallengeOptions, resolveBotChallengeToken } from './bot-challenge.js';
import { extractRequestId } from './internal/request-id.js';
import { networkError } from './oauth/errors.js';
import type { HttpClient } from './types/adapters.js';
import type { OAuthTokenResponse } from './types/auth.js';
import type { AuthError } from './types/auth-error.js';

/**
 * `/v1/auth/*` non-2xx responses are `application/problem+json` (RFC 9457) — `code`/`detail`/
 * `request_id` are top-level fields. None of these endpoints carry the `/oauth/` prefix, so —
 * unlike the `/oauth/token` grant endpoints this module also drives — they never use the RFC 6749
 * §5.2 `{error, error_description}` shape. Parsing them with the OAuth-family parser silently drops
 * the server's actual message and mislabels the failure as `REFRESH_FAILED`/`CODE_EXCHANGE_FAILED`
 * even though no session or code exchange is involved in a magic-link/email-OTP/register call.
 */
function parseAuthEndpointError(status: number, body: { detail?: string; request_id?: string }): AuthError {
  const challenge = botChallengeError(body);
  if (challenge) return challenge;
  const requestId = extractRequestId(body);
  return { code: 'SIGN_IN_FAILED', message: body.detail ?? `Request failed with HTTP ${status}`, ...(requestId && { requestId }) };
}

export interface RequestMagicLinkInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
}

export type RequestResult =
  | { ok: true }
  | { ok: false; error: AuthError };

export async function requestMagicLink(input: RequestMagicLinkInput): Promise<RequestResult> {
  return postNoContent(input.http, `${input.baseUrl}/v1/auth/magic-link`, input.clientId, { email: input.email });
}

export interface VerifyMagicLinkInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  token: string;
}

export type VerifyResult =
  | { ok: true; tokens: OAuthTokenResponse }
  | { ok: true; oauthCode: string; redirectUri: string; codeVerifier?: string }
  | { ok: false; error: AuthError }
  | { ok: false; mfa: { challengeToken: string; expiresIn: number; requiredAcr?: string } };

export async function verifyMagicLink(input: VerifyMagicLinkInput): Promise<VerifyResult> {
  return postAuthVerify(input.http, `${input.baseUrl}/v1/auth/magic-link/verify`, input.clientId, { token: input.token });
}

export interface RequestEmailOtpInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
  mode?: 'login' | 'login_or_create';
}

export async function requestEmailOtp(input: RequestEmailOtpInput): Promise<RequestResult> {
  return postNoContent(input.http, `${input.baseUrl}/v1/auth/email-otp`, input.clientId, {
    email: input.email,
    mode: input.mode ?? 'login',
  });
}

export interface VerifyEmailOtpInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
  code: string;
}

export async function verifyEmailOtp(input: VerifyEmailOtpInput): Promise<VerifyResult> {
  return postAuthVerify(input.http, `${input.baseUrl}/v1/auth/email-otp/verify`, input.clientId, {
    email: input.email,
    code: input.code,
  });
}

export interface RegisterInput extends BotChallengeOptions {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
  password: string;
  /** The user ticked the consent to the tenant's terms and privacy policy. The API refuses a registration without it. */
  consent: boolean;
}

/**
 * `signupBinding` — the value the device or browser that registered keeps and sends back with the
 * verification token ({@link verifyEmail}): only then does the password chosen at registration survive
 * the first verification. Keep it for this flow only (a browser: `sessionStorage`; a native app: in
 * memory), never in persistent storage. When no link was mailed it is a random value of the same shape.
 */
export type RegisterFlowResult =
  | { ok: true; signupBinding?: string }
  | { ok: false; error: AuthError };

export async function register(input: RegisterInput): Promise<RegisterFlowResult> {
  const turnstileToken = await resolveBotChallengeToken(input, 'register');
  const result = await postJson(input.http, `${input.baseUrl}/v1/auth/register`, input.clientId, {
    email: input.email,
    password: input.password,
    consent: input.consent,
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
  });
  if (!result.ok) return result;
  const signupBinding = bindingOf(result.data);
  return signupBinding ? { ok: true, signupBinding } : { ok: true };
}

export interface SignInWithPasswordInput extends BotChallengeOptions {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
  password: string;
}

/**
 * `mfa`: the account has a second factor — verify it with the challenge token (`verifyMfaLogin`).
 * `mfaSetupRequired`: the tenant requires a second factor the account has not set up; it may still
 * sign in until `graceDeadlineAt`, through a flow that enrols one.
 */
export type SignInWithPasswordResult =
  | { ok: true; tokens: OAuthTokenResponse }
  | { ok: false; mfa: { challengeToken: string; expiresIn: number } }
  | { ok: false; mfaSetupRequired: { graceDeadlineAt: string } }
  | { ok: false; error: AuthError };

/** Email + password sign-in (`POST /v1/auth/login`). */
export async function signInWithPassword(input: SignInWithPasswordInput): Promise<SignInWithPasswordResult> {
  const turnstileToken = await resolveBotChallengeToken(input, 'login');
  const result = await postJson(input.http, `${input.baseUrl}/v1/auth/login`, input.clientId, {
    email: input.email,
    password: input.password,
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
  });
  if (!result.ok) return result;
  const data = result.data;
  if (data['next_step'] === 'mfa_challenge') {
    const challengeToken = data['mfa_challenge_token'];
    if (typeof challengeToken !== 'string' || challengeToken.length === 0) {
      return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'MFA challenge token missing from response' } };
    }
    return {
      ok: false,
      mfa: { challengeToken, expiresIn: typeof data['mfa_expires_in'] === 'number' ? data['mfa_expires_in'] : 300 },
    };
  }
  if (data['next_step'] === 'mfa_setup_required') {
    return {
      ok: false,
      mfaSetupRequired: { graceDeadlineAt: typeof data['grace_deadline_at'] === 'string' ? data['grace_deadline_at'] : '' },
    };
  }
  const accessToken = data['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof data['expires_in'] !== 'number' || typeof data['token_type'] !== 'string') {
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'login response did not match the expected shape' } };
  }
  const refreshToken = data['refresh_token'];
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      token_type: data['token_type'],
      expires_in: data['expires_in'],
      ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
    },
  };
}

export interface ForgotPasswordInput extends BotChallengeOptions {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
}

/**
 * Asks for a password-reset e-mail (`POST /v1/auth/forgot-password`). The answer is the same whether
 * or not an account exists for the address; an error means the request itself was refused.
 */
export async function forgotPassword(input: ForgotPasswordInput): Promise<RequestResult> {
  const turnstileToken = await resolveBotChallengeToken(input, 'reset');
  return postNoContent(input.http, `${input.baseUrl}/v1/auth/forgot-password`, input.clientId, {
    email: input.email,
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
  });
}

export interface VerifyEmailInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  /** The token from the verification link. */
  token: string;
  /** Every binding kept since {@link register} and each {@link resendVerification} on this device (at most 5, newest last). */
  signupBindings?: readonly string[];
}

/**
 * `credentialsReset` — the verification was the first proof of the address and carried no matching
 * `signupBinding` (another tab, browser or device): every credential set before it ended, the
 * registration password included. Tell the user and send them to set a password (forgot password).
 */
export type VerifyEmailResult =
  | { ok: true; email?: string; alreadyVerified: boolean; credentialsReset: boolean }
  | { ok: false; error: AuthError };

export async function verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailResult> {
  const result = await postJson(input.http, `${input.baseUrl}/v1/auth/verify-email`, input.clientId, {
    token: input.token,
    ...(input.signupBindings && input.signupBindings.length > 0 ? { signup_binding: [...input.signupBindings] } : {}),
  });
  if (!result.ok) return result;
  const email = typeof result.data['email'] === 'string' ? result.data['email'] : undefined;
  return {
    ok: true,
    ...(email ? { email } : {}),
    alreadyVerified: result.data['already_verified'] === true,
    credentialsReset: result.data['credentials_reset'] === true,
  };
}

export interface ResendVerificationInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
  /** The bindings kept on this device; the answer then carries the binding of the new link. */
  signupBindings?: readonly string[];
}

/**
 * `signupBinding` is ADDED to the kept list (the new link's, or a decoy of the same shape — indistinguishable, so never
 * put in place of an earlier link's binding, which may still be the one clicked). Keep at most the 5 newest.
 */
export async function resendVerification(input: ResendVerificationInput): Promise<RegisterFlowResult> {
  const result = await postJson(input.http, `${input.baseUrl}/v1/auth/resend-verification`, input.clientId, {
    email: input.email,
    ...(input.signupBindings && input.signupBindings.length > 0 ? { signup_binding: [...input.signupBindings] } : {}),
  });
  if (!result.ok) return result;
  const signupBinding = bindingOf(result.data);
  return signupBinding ? { ok: true, signupBinding } : { ok: true };
}

const SIGNUP_BINDING_SHAPE = /^[0-9a-f]{64}$/;

function bindingOf(data: Record<string, unknown>): string | undefined {
  const value = data['signup_binding'];
  return typeof value === 'string' && SIGNUP_BINDING_SHAPE.test(value) ? value : undefined;
}

async function postJson(
  http: HttpClient,
  url: string,
  clientId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: AuthError }> {
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': clientId },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'fetch failed') };
  }
  if (!response.ok) {
    let parsed: { detail?: string; request_id?: string } = {};
    try { parsed = (await response.json()) as typeof parsed; } catch { }
    return { ok: false, error: parseAuthEndpointError(response.status, parsed) };
  }
  try {
    const data = (await response.json()) as unknown;
    return { ok: true, data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {} };
  } catch {
    return { ok: true, data: {} };
  }
}

async function postNoContent(http: HttpClient, url: string, clientId: string, body: Record<string, unknown>): Promise<RequestResult> {
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': clientId },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'fetch failed') };
  }
  if (!response.ok) {
    let parsed: { detail?: string; request_id?: string } = {};
    try { parsed = (await response.json()) as typeof parsed; } catch { }
    return { ok: false, error: parseAuthEndpointError(response.status, parsed) };
  }
  return { ok: true };
}

async function postAuthVerify(http: HttpClient, url: string, clientId: string, body: Record<string, unknown>): Promise<VerifyResult> {
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': clientId },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'fetch failed') };
  }
  if (!response.ok) {
    let parsed: { detail?: string; request_id?: string } = {};
    try { parsed = (await response.json()) as typeof parsed; } catch { }
    return { ok: false, error: parseAuthEndpointError(response.status, parsed) };
  }
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'verify response not JSON' } };
  }
  if (typeof data['access_token'] === 'string' && typeof data['expires_in'] === 'number') {
    return { ok: true, tokens: data as unknown as OAuthTokenResponse };
  }
  if (typeof data['challenge_token'] === 'string') {
    return {
      ok: false,
      mfa: {
        challengeToken: data['challenge_token'] as string,
        expiresIn: typeof data['expires_in'] === 'number' ? (data['expires_in'] as number) : 300,
        requiredAcr: typeof data['required_acr'] === 'string' ? (data['required_acr'] as string) : undefined,
      },
    };
  }
  if (typeof data['code'] === 'string' && typeof data['redirect_uri'] === 'string') {
    return { ok: true, oauthCode: data['code'] as string, redirectUri: data['redirect_uri'] as string };
  }
  return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'verify response did not match any expected shape' } };
}
