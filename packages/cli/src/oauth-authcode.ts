// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';
import type { StoredInstallKey } from './install-key.js';
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
    /**
     * Story rakomi-cli-cimd-per-install-key-binding — an RFC 7523 §2.2 `private_key_jwt`
     * client-assertion, signed with THIS install's own local key, sent ADDITIVELY alongside PKCE
     * (never instead of it — a public CIMD client's PKCE requirement is unaffected). Present ONLY
     * once a PRIOR bind call has confirmed this install's key is the one the server's row trusts
     * (`login.ts`) — never sent speculatively, since a present-but-wrong-key assertion is a hard
     * server-side reject, not a silent fallback.
     */
    readonly clientAssertion?: string;
    /**
     * Story rakomi-cli-dpop-token-binding — the install key, if this install has one (i.e. the CIMD
     * default client_id was used). Sent UNCONDITIONALLY on every token-endpoint call when present —
     * NOT gated on a prior TOFU-bind confirmation (unlike `clientAssertion` above, which answers "who
     * is this client" and would lock out a losing install if sent speculatively). DPoP proof-of-
     * possession answers a DIFFERENT question — "does the caller hold the key this token gets bound
     * to" — and every install's OWN key independently proves possession for whichever token THAT
     * install is issued, regardless of the client_assertion TOFU outcome (see `install-key.ts`'s
     * `resolveDpopKey()` doc). The server ignores the proof and mints an ordinary Bearer token
     * whenever `dpop_mode` is `'off'` for this client_id — strictly additive, never a downgrade risk.
     */
    readonly dpopKey?: StoredInstallKey;
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
      ...(opts.clientAssertion
        ? {
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: opts.clientAssertion,
          }
        : {}),
    },
    dpop: opts.dpopKey ? { key: opts.dpopKey } : undefined,
  });
  if (result.status !== 200) {
    throw new CliError(`Could not complete sign-in: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
