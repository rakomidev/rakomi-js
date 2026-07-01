/**
 * Browser-safe OAuth token endpoint helpers.
 * No client_secret — public client with PKCE is sole proof.
 *
 * All fetch calls use credentials: 'omit' to prevent accidental cookie leakage
 * and avoid CORS credential conflicts with the Rakomi API's origin-echo configuration.
 */

import { normalizeNetworkError,sdkFetch } from '../lib/fetch-client.js';
import type { OAuthTokenResponse } from '../types.js';
import { networkError, parseTokenEndpointError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.rakomi.com';

type TokenResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: false; error: import('../types.js').AuthError };

/**
 * Exchange an authorization code for tokens.
 * Public client: no client_secret (PKCE code_verifier is sole proof per RFC 6749 §2.1).
 */
export async function exchangeCode(options: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  baseUrl?: string;
}): Promise<TokenResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  });

  return tokenRequest(baseUrl, body);
}

/**
 * Refresh an access token using a refresh token.
 * Public client: no client_secret needed (session is bound to client via oauthClientId).
 */
export async function refreshToken(options: {
  refreshToken: string;
  clientId: string;
  baseUrl?: string;
}): Promise<TokenResult> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });

  return tokenRequest(baseUrl, body);
}

async function tokenRequest(baseUrl: string, body: URLSearchParams): Promise<TokenResult> {
  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    return { ok: false, error: networkError(normalizeNetworkError(err)) };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: networkError('Invalid JSON response from token endpoint') };
  }

  if (!response.ok) {
    const errorBody = json as { error?: string; error_description?: string };
    return { ok: false, error: parseTokenEndpointError(response.status, errorBody) };
  }

  const r = json as Record<string, unknown>;
  if (
    typeof r['access_token'] !== 'string' ||
    r['access_token'].length === 0 ||
    r['access_token'].length > 8192 ||
    typeof r['expires_in'] !== 'number' ||
    typeof r['token_type'] !== 'string'
  ) {
    return { ok: false, error: networkError('Invalid token response shape from token endpoint') };
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
