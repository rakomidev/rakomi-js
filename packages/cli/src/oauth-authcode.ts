// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';
import type { PkcePair } from './pkce.js';

export interface AuthCodeTokenResult {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: string;
  readonly expires_in: number;
}

export function buildAuthorizeUrl(opts: {
  readonly accountsBaseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly pkce: PkcePair;
  readonly scope: string;
}): string {
  const url = new URL('/authorize', opts.accountsBaseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('state', opts.pkce.state);
  url.searchParams.set('code_challenge', opts.pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', opts.pkce.codeChallengeMethod);
  return url.toString();
}

export async function exchangeAuthorizationCode(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
  },
): Promise<AuthCodeTokenResult> {
  const result = await request<AuthCodeTokenResult & { error?: string }>(deps, {
    method: 'POST',
    url: `${opts.apiBaseUrl}/oauth/token`,
    form: {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.codeVerifier,
    },
  });
  if (result.status !== 200) {
    throw new CliError(`Could not complete sign-in: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
