/**
 * Direct-auth hooks — (magic-link, email-OTP, register, verify-email, password sign-in, forgot-password).
 *
 * Bot challenge: when `useAuthConfig().config.botChallenge` is present, register, password sign-in and
 * forgot-password must carry a Cloudflare Turnstile token. This package renders no widget; pass a token
 * your app obtained (for example from a WebView hosting the Turnstile widget on one of the environment's
 * allowed redirect URI hosts) as `{ turnstileToken }` or `{ turnstileTokenProvider }`. A refusal is an
 * `AuthError` with code `BOT_CHALLENGE_FAILED`.
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
  type BotChallengeOptions,
  forgotPassword as coreForgotPassword,
  register as coreRegister,
  type RegisterFlowResult,
  requestEmailOtp as coreRequestEmailOtp,
  requestMagicLink as coreRequestMagicLink,
  type RequestResult,
  resendVerification as coreResendVerification,
  signInWithPassword as coreSignInWithPassword,
  type SignInWithPasswordResult,
  verifyEmail as coreVerifyEmail,
  verifyEmailOtp as coreVerifyEmailOtp,
  type VerifyEmailResult,
  verifyMagicLink as coreVerifyMagicLink,
  type VerifyResult,
  verifyTotp as coreVerifyTotp,
} from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';
import { forgetSignupBindings, keepSignupBinding, readSignupBindings } from '../internal/signup-binding-memory.js';

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
  /** `consent`: the user accepted the tenant's terms and privacy policy (the API refuses a registration without it). The
   *  answer's signup binding is kept in memory for {@link useVerifyEmail} (never persisted). */
  register: (email: string, password: string, consent: boolean, options?: BotChallengeOptions) => Promise<RegisterFlowResult>;
  /** Resends the verification e-mail with the binding kept in memory, and keeps the new link's binding instead. */
  resendVerification: (email: string) => Promise<RegisterFlowResult>;
}

export function useRegister(): UseRegisterResult {
  const ctx = useRakomiContext();
  return {
    register: async (email, password, consent, options) => {
      ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'register' } });
      const result = await coreRegister({ ...options, http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email, password, consent });
      if (result.ok) keepSignupBinding(ctx.publishableKey, result.signupBinding);
      return result;
    },
    resendVerification: async (email) => {
      const result = await coreResendVerification({
        http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email, signupBindings: readSignupBindings(ctx.publishableKey),
      });
      if (result.ok) keepSignupBinding(ctx.publishableKey, result.signupBinding);
      return result;
    },
  };
}

export interface UseVerifyEmailResult {
  /**
   * Verifies the token from the verification link with the binding kept in memory since `register` in this app process,
   * then forgets it. `credentialsReset: true` (the link was opened on another device, or after the app restarted) means
   * the registration password was removed: send the user to set a new one (forgot password).
   */
  verify: (token: string) => Promise<VerifyEmailResult>;
}

export function useVerifyEmail(): UseVerifyEmailResult {
  const ctx = useRakomiContext();
  return {
    verify: async (token) => {
      const result = await coreVerifyEmail({
        http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, token, signupBindings: readSignupBindings(ctx.publishableKey),
      });
      if (result.ok) forgetSignupBindings(ctx.publishableKey);
      else emitError(ctx.events, result.error);
      return result;
    },
  };
}

export interface UsePasswordSignInResult {
  /**
   * Email + password sign-in. On `tokens` the session is stored; `mfa` / `mfaSetupRequired` are returned
   * for the app to drive (`useMfa`). `options`: the Turnstile token when the environment requires one.
   */
  signIn: (email: string, password: string, options?: BotChallengeOptions) => Promise<SignInWithPasswordResult>;
}

export function usePasswordSignIn(): UsePasswordSignInResult {
  const ctx = useRakomiContext();
  return {
    signIn: async (email, password, options) => {
      ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'password' } });
      const result = await coreSignInWithPassword({ ...options, http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email, password });
      if (result.ok) {
        const nonce = await ctx.beginAuthFlow();
        await ctx.submitOAuthTokens(result.tokens, nonce);
      } else if ('error' in result) {
        emitError(ctx.events, result.error);
      }
      return result;
    },
  };
}

export interface UseForgotPasswordResult {
  /** Asks for a password-reset e-mail; the answer is the same whether or not the account exists. */
  request: (email: string, options?: BotChallengeOptions) => Promise<RequestResult>;
}

export function useForgotPassword(): UseForgotPasswordResult {
  const ctx = useRakomiContext();
  return {
    request: async (email, options) => coreForgotPassword({ ...options, http: ctx.http, baseUrl: ctx.baseUrl, clientId: ctx.publishableKey, email }),
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
      const url = endpoint ?? `${ctx.baseUrl}/v1/auth/mfa/verify-login`;
      const result = await coreVerifyTotp({ http: ctx.http, endpoint: url, apiKey: ctx.publishableKey, challengeToken, code });
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
