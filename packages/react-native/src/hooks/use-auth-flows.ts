/**
 * Direct-auth hooks — (magic-link, email-OTP, register).
 *
 * Wraps `@rakomi/sdk-core` direct-auth helpers with `useRakomiContext` wiring so
 * consumers don't have to thread `http` / `baseUrl` / `clientId` themselves.
 *
 * On verify success:
 * - `tokens` variant → calls `submitOAuthTokens` (dispatches SIGN_IN_SUCCESS).
 * - `oauthCode` variant → caller is responsible for the code → token exchange (PKCE binding).
 * - `mfa` variant → caller drives MFA UI; SDK does not auto-dispatch MFA_REQUIRED here
 * (component layer owns that decision).
 */

'use client';

import {
  type AuthError,
  register as coreRegister,
  requestEmailOtp as coreRequestEmailOtp,
  requestMagicLink as coreRequestMagicLink,
  type RequestResult,
  verifyEmailOtp as coreVerifyEmailOtp,
  verifyMagicLink as coreVerifyMagicLink,
  type VerifyResult,
  verifyTotp as coreVerifyTotp,
} from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

export interface UseMagicLinkResult {
  request: (email: string) => Promise<RequestResult>;
  verify: (token: string) => Promise<VerifyResult>;
}

export function useMagicLink(): UseMagicLinkResult {
  const ctx = useRakomiContext();
  return {
    request: async (email: string) => {
      ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'magic_link' } });
      return coreRequestMagicLink({ http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email });
    },
    verify: async (token: string) => {
      const result = await coreVerifyMagicLink({ http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, token });
      if (result.ok && 'tokens' in result) {
        const nonce = await ctx.beginAuthFlow();
        await ctx.submitOAuthTokens(result.tokens, nonce);
      } else if (!result.ok && 'error' in result) {
        emitError(ctx.events, result.error);
      }
      return result;
    },
  };
}

export interface UseEmailOtpResult {
  request: (email: string, mode?: 'login' | 'login_or_create') => Promise<RequestResult>;
  verify: (email: string, code: string) => Promise<VerifyResult>;
}

export function useEmailOtp(): UseEmailOtpResult {
  const ctx = useRakomiContext();
  return {
    request: async (email, mode) => {
      ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'email_otp', mode } });
      return coreRequestEmailOtp({ http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email, mode });
    },
    verify: async (email, code) => {
      const result = await coreVerifyEmailOtp({ http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email, code });
      if (result.ok && 'tokens' in result) {
        const nonce = await ctx.beginAuthFlow();
        await ctx.submitOAuthTokens(result.tokens, nonce);
      } else if (!result.ok && 'error' in result) {
        emitError(ctx.events, result.error);
      }
      return result;
    },
  };
}

export interface UseRegisterResult {
  register: (email: string, password: string) => Promise<RequestResult>;
}

export function useRegister(): UseRegisterResult {
  const ctx = useRakomiContext();
  return {
    register: async (email, password) => {
      ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'register' } });
      return coreRegister({ http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email, password });
    },
  };
}

function emitError(events: ReturnType<typeof useRakomiContext>['events'], error: AuthError): void {
  events.push({ type: 'sign_in_failed', severity: 'warning', error });
}

export interface UseMfaResult {
  /**
   * Verify a TOTP code against the MFA challenge token surfaced by `verifyMagicLink`
   * or `verifyEmailOtp` when their result is the `mfa` variant.
   *
   * On success, server-issued tokens are submitted to the runtime and `SIGN_IN_SUCCESS`
   * is dispatched. On failure, returns the error so the caller can surface it in UI.
   */
  verifyTotp: (challengeToken: string, code: string, endpoint?: string) => Promise<{ ok: true } | { ok: false; error: AuthError }>;
}

export function useMfa(): UseMfaResult {
  const ctx = useRakomiContext();
  return {
    verifyTotp: async (challengeToken, code, endpoint) => {
      const url = endpoint ?? `${ctx.baseUrl}/v1/auth/mfa/totp/verify`;
      const result = await coreVerifyTotp({ http: ctx.http, endpoint: url, challengeToken, code });
      if (result.ok) {
        const nonce = await ctx.beginAuthFlow();
        await ctx.submitOAuthTokens({
          access_token: result.tokens.access_token,
          token_type: result.tokens.token_type,
          expires_in: result.tokens.expires_in,
          refresh_token: result.tokens.refresh_token,
        }, nonce);
        ctx.events.push({ type: 'signed_in', severity: 'info', metadata: { method: 'mfa_totp' } });
        return { ok: true };
      }
      emitError(ctx.events, result.error);
      return { ok: false, error: result.error };
    },
  };
}
