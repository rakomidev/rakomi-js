/**
 * Social auth URL builder — constructs redirect URL for /oauth/{provider}/authorize.
 * Reuses existing PKCE state/verifier from sessionStorage (same as redirect-mode sign-in).
 * Pure function — no fetch, no side effects (URL construction only).
 */

export function buildSocialAuthorizeUrl(options: {
  baseUrl: string;
  provider: string;
  tenantId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  clientId: string;
}): string {
  const { baseUrl, provider, tenantId, redirectUri, state, codeChallenge, clientId } = options;

  if (!/^[a-z0-9_-]+$/.test(provider)) {
    return '';
  }

  const url = new URL(`${baseUrl}/oauth/${provider}/authorize`);
  url.searchParams.set('tenant_id', tenantId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('oauth_state', state);
  url.searchParams.set('oauth_client_id', clientId);
  url.searchParams.set('oauth_code_challenge', codeChallenge);
  url.searchParams.set('oauth_code_challenge_method', 'S256');

  return url.toString();
}
