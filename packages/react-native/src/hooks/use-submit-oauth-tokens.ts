/**
 * `useSubmitOAuthTokens` — bridge between `startSocialSignIn` (free function) and the
 * `<RakomiProvider>` runtime.
 *
 * this hook issues a fresh submit-nonce on every call (5-min TTL, single-use).
 * The nonce is invisible to the consumer — the public surface stays a single-arg function,
 * but the runtime is protected against arbitrary `OAuthTokenResponse` injection from
 * third-party components.
 *
 * Consumer pattern:
 * ```tsx
 * const submit = useSubmitOAuthTokens;
 * const outcome = await startSocialSignIn({... });
 * if (outcome.ok) await submit(outcome.tokens);
 * ```
 *
 * Calling `submit` persists the refresh token to secure storage and dispatches
 * `SIGN_IN_SUCCESS` so `useAuth.isSignedIn` flips to `true` and `getToken` becomes available.
 */

'use client';

import type { OAuthTokenResponse } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

export function useSubmitOAuthTokens(): (tokens: OAuthTokenResponse) => Promise<void> {
  const ctx = useRakomiContext();
  return async (tokens: OAuthTokenResponse) => {
    const nonce = await ctx.beginAuthFlow();
    await ctx.submitOAuthTokens(tokens, nonce);
  };
}
