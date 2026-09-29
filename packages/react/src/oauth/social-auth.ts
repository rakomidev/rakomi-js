/**
 * Social auth URL builder — constructs redirect URL for /oauth/{provider}/authorize.
 * Reuses existing PKCE state/verifier from sessionStorage (same as redirect-mode sign-in).
 * Pure function — no fetch, no side effects (URL construction only).
 *
 * Sends only the OAuth client id (`oauth_client_id`) — never a tenant identifier. The initiate
 * endpoint accepts `oauth_client_id` on its own and resolves the tenant from it, the same way it
 * already resolves a tenant from `tenant_id`/`tenant_slug` when those are supplied instead.
 */

export function buildSocialAuthorizeUrl(options: {
  baseUrl: string;
  provider: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  clientId: string;
}): string {
  const { baseUrl, provider, redirectUri, state, codeChallenge, clientId } = options;

  if (!/^[a-z0-9_-]+$/.test(provider)) {
    return '';
  }

  const url = new URL(`${baseUrl}/oauth/${provider}/authorize`);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('oauth_state', state);
  url.searchParams.set('oauth_client_id', clientId);
  url.searchParams.set('oauth_code_challenge', codeChallenge);
  url.searchParams.set('oauth_code_challenge_method', 'S256');

  return url.toString();
}
