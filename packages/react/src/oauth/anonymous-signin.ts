/**
 * Anonymous sign-in wire call for the React SDK.
 *
 * Mirrors the shape of directSignIn so context.tsx can route mode='anonymous'
 * through the same token-manager handoff. On 4xx, returns a typed AuthError; never throws.
 */

import { normalizeNetworkError, sdkFetch } from '../lib/fetch-client.js';
import type { AuthError, OAuthTokenResponse } from '../types.js';

export type AnonymousSignInResult =
  | { ok: true; data: OAuthTokenResponse }
  | { ok: false; error: AuthError };

export async function anonymousSignIn(options: {
  baseUrl: string;
  apiKey: string;
  publicMetadata?: Record<string, unknown>;
}): Promise<AnonymousSignInResult> {
  const { baseUrl, apiKey, publicMetadata } = options;

  if (!apiKey) {
    return {
      ok: false,
      error: { code: 'INVALID_CONFIG' as const, message: 'apiKey (clientId) is required for anonymous sign-in' },
    };
  }

  let response: Response;
  try {
    response = await sdkFetch(`${baseUrl}/v1/auth/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(publicMetadata ? { public_metadata: publicMetadata } : {}),
    });
  } catch (err) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: normalizeNetworkError(err) } };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid JSON response from /v1/auth/anonymous' } };
  }

  if (response.status === 403) {
    return {
      ok: false,
      error: {
        code: 'SIGN_IN_FAILED' as const,
        message: 'Anonymous sign-ins are not enabled for this tenant.',
      },
    };
  }
  if (response.status === 402) {
    return {
      ok: false,
      error: { code: 'SIGN_IN_FAILED' as const, message: 'Tenant MAU cap reached — cannot create new anonymous users.' },
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      error: { code: 'SIGN_IN_FAILED' as const, message: 'Rate limit exceeded for anonymous sign-ins.' },
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { code: 'SIGN_IN_FAILED' as const, message: `Anonymous sign-in failed with status ${response.status}` },
    };
  }

  const r = json as Record<string, unknown>;
  if (
    typeof r['access_token'] !== 'string' ||
    r['access_token'].length === 0 ||
    r['access_token'].length > 8192 ||
    typeof r['expires_in'] !== 'number' ||
    typeof r['token_type'] !== 'string'
  ) {
    return { ok: false, error: { code: 'NETWORK_ERROR' as const, message: 'Invalid anonymous response shape' } };
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
