// SPDX-License-Identifier: MIT

import { buildDpopProof, canonicalizeHtu, generateEphemeralDpopKey } from './dpop.js';
import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';

/**
 * RFC 8693 §3 — the `subject_token_type` this endpoint dispatches on, mirrored from the matching
 * constant on the server side. This package ships ZERO runtime deps (see `env.ts`'s
 * `isCimdClientId`'s own comment for why importing the server's implementation is not an option),
 * so this is a from-scratch literal that MUST stay byte-identical to the server constant — kept in
 * sync by convention, the same discipline `login.ts`'s `LOGIN_SCOPE` already uses for the CIMD
 * document's own `scope` field.
 */
export const OIDC_FEDERATION_SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

export interface OidcFederationTokenResult {
  readonly access_token: string;
  /** Always `'DPoP'` in practice — this grant runs the server's `dpopMode: 'on'` (mandatory), so a
   * successful mint always binds a `cnf.jkt`. Typed as the wider union anyway, matching the
   * server's own `RFC8693TokenExchangeResponse` shape, rather than asserting a narrower literal
   * this module does not independently verify. */
  readonly token_type: 'Bearer' | 'DPoP';
  readonly expires_in: number;
  readonly scope: string;
}

/**
 * Exchanges an already-resolved OIDC identity token for a short-lived, DPoP-bound Rakomi access
 * token. No `client_id` is sent — this grant authenticates on the tenant's TRUST POLICY, not an
 * `oauth_clients` row (`token-route.ts`'s `handleOidcFederationTokenExchangeGrant` dispatches on
 * `subject_token_type` BEFORE the endpoint's ordinary client-authentication step). DPoP is
 * MANDATORY on this flow server-side, so a proof is built and sent unconditionally — never
 * reused across requests (`buildDpopProof` mints a fresh `jti` every call).
 */
export async function exchangeOidcSubjectToken(
  deps: HttpDeps,
  opts: { readonly apiBaseUrl: string; readonly subjectToken: string; readonly resource: string },
): Promise<OidcFederationTokenResult> {
  const tokenUrl = `${opts.apiBaseUrl}/oauth/token`;
  const dpopKey = generateEphemeralDpopKey();
  const proof = buildDpopProof(dpopKey, { htm: 'POST', htu: canonicalizeHtu(tokenUrl) });

  const result = await request<OidcFederationTokenResult & { error?: string }>(deps, {
    method: 'POST',
    url: tokenUrl,
    headers: { dpop: proof },
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: opts.subjectToken,
      subject_token_type: OIDC_FEDERATION_SUBJECT_TOKEN_TYPE,
      resource: opts.resource,
    },
  });

  if (result.status !== 200) {
    throw new CliError(`Could not sign in from CI: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
