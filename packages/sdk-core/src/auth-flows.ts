/**
 * Direct-auth helpers.
 *
 * Platform-neutral wrappers around the Rakomi authn endpoints:
 * - POST /v1/auth/magic-link
 * - POST /v1/auth/magic-link/verify
 * - POST /v1/auth/email-otp
 * - POST /v1/auth/email-otp/verify
 * - POST /v1/auth/register
 *
 * Both magic-link and email-otp verify endpoints can return either a token bundle
 * directly or an OAuth `code` to be exchanged via `/oauth/token`. Callers normalise
 * via the discriminated `MagicLinkVerifyResult` / `EmailOtpVerifyResult` shapes.
 */

import { networkError, parseTokenEndpointError } from './oauth/errors.js';
import type { HttpClient } from './types/adapters.js';
import type { OAuthTokenResponse } from './types/auth.js';
import type { AuthError } from './types/auth-error.js';

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

export interface RegisterInput {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  email: string;
  password: string;
}

export async function register(input: RegisterInput): Promise<RequestResult> {
  return postNoContent(input.http, `${input.baseUrl}/v1/auth/register`, input.clientId, {
    email: input.email,
    password: input.password,
  });
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
    let parsed: { error?: string; error_description?: string } = {};
    try { parsed = (await response.json()) as typeof parsed; } catch { }
    return { ok: false, error: parseTokenEndpointError(response.status, parsed) };
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
    let parsed: { error?: string; error_description?: string } = {};
    try { parsed = (await response.json()) as typeof parsed; } catch { }
    return { ok: false, error: parseTokenEndpointError(response.status, parsed) };
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
