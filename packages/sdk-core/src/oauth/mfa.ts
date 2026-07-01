/**
 * MFA TOTP verification + step-up error handling.
 *
 * Contract:
 * - `next_action: 'verify_mfa'` (NOT the legacy `mfa_challenge_token`).
 * - `MfaStepUpRequiredError` and `MfaStepUpUnavailableError` partition the 401 space.
 */

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
  /** Canonical: `${baseUrl}/v1/auth/mfa/totp/verify` (per). */
  endpoint: string;
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
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ challenge_token: input.challengeToken, code }),
    });
  } catch (err) {
    return { ok: false, error: networkError(err instanceof Error ? err.message : 'network') };
  }
  if (!response.ok) {
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: `MFA verification failed (${response.status})` } };
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
