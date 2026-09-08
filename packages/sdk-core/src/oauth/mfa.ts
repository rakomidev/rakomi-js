/**
 * MFA TOTP verification + step-up error handling.
 *
 * Contract:
 * - Request body: `{ mfa_challenge_token, code }`.
 * - `POST /v1/auth/mfa/verify-login` requires the `X-API-Key` header like every other `/v1/auth/*`
 *   endpoint — it is NOT optional.
 * - Non-2xx responses are `application/problem+json` (RFC 9457) — `detail` carries the
 *   occurrence-specific message, never the OAuth-family `{error, error_description}` shape (this
 *   endpoint has no `/oauth/` prefix, so it does not follow that convention).
 * - `MfaStepUpRequiredError` and `MfaStepUpUnavailableError` partition the 401 space.
 */

import { extractRequestId } from '../internal/request-id.js';
import type { HttpClient } from '../types/adapters.js';
import type { AuthError } from '../types/auth-error.js';
import { networkError } from './errors.js';

export class MfaStepUpRequiredError extends Error {
  readonly code = 'MFA_STEP_UP_REQUIRED' as const;
  /** RFC 9470 acr_values requested by the server. */
  readonly requiredAcr?: string;
  readonly challengeToken: string;
  readonly expiresIn: number;
  constructor(input: { challengeToken: string; expiresIn: number; requiredAcr?: string }) {
    super('MFA step-up required');
    this.name = 'MfaStepUpRequiredError';
    this.challengeToken = input.challengeToken;
    this.expiresIn = input.expiresIn;
    this.requiredAcr = input.requiredAcr;
  }
}

export class MfaStepUpUnavailableError extends Error {
  readonly code = 'MFA_STEP_UP_UNAVAILABLE' as const;
  /** Server-supplied SDK guidance text — surface to user verbatim. */
  readonly guidance: string;
  constructor(guidance: string) {
    super('MFA step-up not available for this user');
    this.name = 'MfaStepUpUnavailableError';
    this.guidance = guidance;
  }
}

export interface VerifyTotpInput {
  http: HttpClient;
  /** Canonical: `${baseUrl}/v1/auth/mfa/verify-login`. */
  endpoint: string;
  /** Tenant publishable key — sent as `X-API-Key` (this endpoint rejects the request without it). */
  apiKey: string;
  challengeToken: string;
  code: string;
}

export type VerifyTotpResult =
  | { ok: true; tokens: { access_token: string; refresh_token?: string; expires_in: number; token_type: string } }
  | { ok: false; error: AuthError };

export async function verifyTotp(input: VerifyTotpInput): Promise<VerifyTotpResult> {
  const code = String(input.code).replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) {
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'TOTP code must be 6 digits' } };
  }
  let response: Response;
  try {
    response = await input.http.fetch(input.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': input.apiKey },
      body: JSON.stringify({ mfa_challenge_token: input.challengeToken, code }),
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'network') };
  }
  if (!response.ok) {
    let detail: string | undefined;
    let requestId: string | undefined;
    try {
      const body = (await response.json()) as { detail?: string; request_id?: string };
      detail = body?.detail;
      requestId = extractRequestId(body);
    } catch {
    }
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: detail ?? `MFA verification failed (${response.status})`, ...(requestId && { requestId }) } };
  }
  try {
    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (typeof json.access_token === 'string' && typeof json.expires_in === 'number') {
      return {
        ok: true,
        tokens: {
          access_token: json.access_token,
          refresh_token: json.refresh_token,
          expires_in: json.expires_in,
          token_type: json.token_type ?? 'Bearer',
        },
      };
    }
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'MFA response malformed' } };
  } catch {
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'MFA response not JSON' } };
  }
}
