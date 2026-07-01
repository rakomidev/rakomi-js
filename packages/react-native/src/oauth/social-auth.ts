/**
 * RFC 8252 OAuth flow orchestrator for React Native / Expo.
 *
 * system browser ONLY (`expo-web-browser.openAuthSessionAsync`).
 * PKCE S256 mandatory. State 32 bytes, single-use, 60s TTL, constant-time compare.
 * Confused-deputy guard: redirect URI scheme/host re-checked client-side after callback ingest.
 *
 * No `WebView` (codebase guard the project lint guards enforces).
 */

import type { AuthError, HttpClient } from '@rakomi/sdk-core';
import {
  buildAuthorizationUrl,
  consumeState,
  exchangeAuthCode,
  generatePkce,
  issueState,
  parseOAuthCallbackError,
} from '@rakomi/sdk-core';

import type { DpopSession } from '../internal/dpop-session.js';
import type { NativeAuthAdapter } from '../native/types.js';

export interface StartSocialSignInInput {
  adapter: NativeAuthAdapter;
  http: HttpClient;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  provider: string;
  scope?: string;
  acrValues?: string;
  preferEphemeralSession?: boolean;
  /**
 * Optional DPoP binding handle (opt-in at issuance). When supplied, a fresh RFC 9449 proof is
 * attached to the code→token exchange so the server binds `dpop_jkt` to THIS
 * session's native keypair; the SAME `DpopSession` must then be wired into the
 * runtime so every refresh re-presents the bound key. Pass the session
 * `<RakomiProvider>` auto-constructs from `NativeAuthAdapter.dpopProver`.
 *
 * Absent ⇒ a plain Bearer issuance (unchanged behaviour).
 */
  dpopSession?: DpopSession;
}

export type SocialSignInOutcome =
  | { ok: true; tokens: { access_token: string; refresh_token?: string; expires_in: number; token_type: string } }
  | { ok: false; error: AuthError };

const PKCE_STORAGE_KEY = 'rakomi.oauth.pkce.in-flight';

/**
 * Start a social-provider sign-in. Opens the system browser, waits for the
 * deep-link callback, validates state + scheme, exchanges the code for tokens.
 *
 * Idempotent: only one OAuth ceremony can be in flight per call. Caller must
 * serialize concurrent invocations themselves.
 */
export async function startSocialSignIn(input: StartSocialSignInInput): Promise<SocialSignInOutcome> {
  const { adapter, http } = input;

  const pkce = await generatePkce(adapter.crypto);

  const state = await issueState(adapter.crypto, adapter.storage);

  const pkceRecord = JSON.stringify({ codeVerifier: pkce.codeVerifier });
  await adapter.storage.setItem(PKCE_STORAGE_KEY, pkceRecord, { keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' });

  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: input.authorizationEndpoint,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    state: state.state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: 'S256',
    scope: input.scope,
    provider: input.provider,
    acrValues: input.acrValues,
  });

  const result = await adapter.browser.openAuthSession(authUrl, input.redirectUri, {
    preferEphemeralSession: input.preferEphemeralSession ?? true,
  });

  if (result.type !== 'success') {
    await adapter.storage.removeItem(PKCE_STORAGE_KEY).catch(() => undefined);
    if (result.type === 'cancel') {
      return { ok: false, error: { code: 'OAUTH_CALLBACK_ERROR', oauthError: 'oauth_user_cancelled', description: 'User cancelled the sign-in flow' } };
    }
    if (result.type === 'dismiss') {
      return { ok: false, error: { code: 'OAUTH_CALLBACK_ERROR', oauthError: 'oauth_user_cancelled', description: 'Sign-in dismissed' } };
    }
    if (result.type === 'locked') {
      return { ok: false, error: { code: 'OAUTH_CALLBACK_ERROR', oauthError: 'oauth_locked', description: 'iOS auto-fill locked the auth session' } };
    }
    return { ok: false, error: { code: 'SIGN_IN_FAILED', message: 'unknown browser auth result' } };
  }

  const url = result.url;
  const parsed = parseCallback(url, input.redirectUri);
  if (!parsed.ok) {
    await adapter.storage.removeItem(PKCE_STORAGE_KEY).catch(() => undefined);
    return { ok: false, error: parsed.error };
  }

  const stateCheck = await consumeState(adapter.storage, state.storageKey, parsed.state);
  if (!stateCheck.ok) {
    await adapter.storage.removeItem(PKCE_STORAGE_KEY).catch(() => undefined);
    return {
      ok: false,
      error: {
        code: 'OAUTH_CALLBACK_ERROR',
        oauthError: 'oauth_state_mismatch',
        description: `State validation failed (${stateCheck.reason})`,
      },
    };
  }

  const pkceRecovered = await adapter.storage.getItem(PKCE_STORAGE_KEY);
  await adapter.storage.removeItem(PKCE_STORAGE_KEY).catch(() => undefined);
  if (!pkceRecovered) {
    return { ok: false, error: { code: 'CODE_EXCHANGE_FAILED', message: 'PKCE verifier missing' } };
  }
  let codeVerifier: string;
  try {
    const parsedPkce = JSON.parse(pkceRecovered) as { codeVerifier?: string };
    if (typeof parsedPkce.codeVerifier !== 'string') throw new TypeError('bad PKCE record');
    codeVerifier = parsedPkce.codeVerifier;
  } catch {
    return { ok: false, error: { code: 'CODE_EXCHANGE_FAILED', message: 'PKCE record corrupted' } };
  }

  let dpopProof: string | undefined;
  if (input.dpopSession) {
    try {
      dpopProof = await input.dpopSession.resolveProof('POST', input.tokenEndpoint);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'CODE_EXCHANGE_FAILED',
          message: `DPoP prover unavailable at issuance: ${e instanceof Error ? e.message : 'signer threw'}`,
        },
      };
    }
  }

  const exchange = await exchangeAuthCode({
    http,
    tokenEndpoint: input.tokenEndpoint,
    code: parsed.code,
    codeVerifier,
    redirectUri: input.redirectUri,
    clientId: input.clientId,
    ...(dpopProof !== undefined ? { dpopProof } : {}),
  });
  if (!exchange.ok) return exchange;

  if (input.dpopSession) {
    await input.dpopSession.observeTokenType(exchange.tokens.token_type, dpopProof !== undefined);
  }

  return {
    ok: true,
    tokens: {
      access_token: exchange.tokens.access_token,
      refresh_token: exchange.tokens.refresh_token,
      expires_in: exchange.tokens.expires_in,
      token_type: exchange.tokens.token_type,
    },
  };
}

/**
 * Parse a callback URL and validate it has the expected redirect-URI scheme + host
 * (confused-deputy guard).
 */
function parseCallback(callbackUrl: string, expectedRedirectUri: string):
  | { ok: true; code: string; state: string }
  | { ok: false; error: AuthError } {
  const expected = matchSchemeAndHost(expectedRedirectUri);
  const actual = matchSchemeAndHost(callbackUrl);
  if (!expected || !actual || expected.scheme !== actual.scheme || expected.host !== actual.host) {
    return {
      ok: false,
      error: {
        code: 'OAUTH_CALLBACK_ERROR',
        oauthError: 'oauth_redirect_mismatch',
        description: 'Callback redirect URI scheme/host changed mid-flow (confused-deputy guard)',
      },
    };
  }

  const queryStart = callbackUrl.indexOf('?');
  const query = queryStart >= 0 ? callbackUrl.slice(queryStart + 1) : '';
  const params = new URLSearchParams(query);
  const error = params.get('error');
  if (error) {
    return {
      ok: false,
      error: parseOAuthCallbackError(error, params.get('error_description') ?? undefined),
    };
  }
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    return {
      ok: false,
      error: {
        code: 'OAUTH_CALLBACK_ERROR',
        oauthError: 'oauth_missing_params',
        description: 'Callback URL missing code or state',
      },
    };
  }
  return { ok: true, code, state };
}

function matchSchemeAndHost(url: string): { scheme: string; host: string } | null {
  const m = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase() };
}
