/**
 * Build an OAuth /authorize URL.
 * Pure function — no crypto, no fetch, no side effects.
 */

const DEFAULT_SCOPE = 'openid profile email';

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string | string[];
  baseUrl?: string;
}

/**
 * Build the full /oauth/authorize URL with all required parameters.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const baseUrl = options.baseUrl ?? 'https://api.rakomi.com';
  const scope = Array.isArray(options.scope)
    ? options.scope.join(' ')
    : (options.scope ?? DEFAULT_SCOPE);

  const url = new URL('/oauth/authorize', baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
