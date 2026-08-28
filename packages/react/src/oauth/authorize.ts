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
  /**
   * Full authorization-endpoint URL to navigate the browser to (e.g. resolved via OIDC
   * discovery's `authorization_endpoint`). When supplied, this exact URL is used as the base and
   * `baseUrl`/`/oauth/authorize` is NOT applied. Omit to keep the previous `${baseUrl}/oauth/authorize`
   * behavior unchanged.
   */
  authorizationEndpoint?: string;
}

/**
 * Build the full authorize URL with all required parameters.
 *
 * Defaults to `${baseUrl}/oauth/authorize` when no `authorizationEndpoint` override is given —
 * unchanged from previous versions. Callers driving a real top-level browser navigation (a "Sign
 * in" button) should resolve `authorizationEndpoint` via discovery first; see `RakomiProvider`'s
 * own `signIn()`, which does exactly that.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const baseUrl = options.baseUrl ?? 'https://api.rakomi.com';
  const scope = Array.isArray(options.scope)
    ? options.scope.join(' ')
    : (options.scope ?? DEFAULT_SCOPE);

  const url = options.authorizationEndpoint
    ? new URL(options.authorizationEndpoint)
    : new URL('/oauth/authorize', baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
