// SPDX-License-Identifier: MIT

import type { DpopKeyPair } from './dpop.js';
import { buildDpopProof, canonicalizeHtu } from './dpop.js';
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

/**
 * The query-parameter NAME the REQUIRED tenant selector rides on, appended to the `resource` this
 * module sends. It mirrors the
 * server's `OIDC_FEDERATION_TENANT_SELECTOR_QUERY_PARAM` constant; this package ships with zero runtime
 * dependencies (see the `OIDC_FEDERATION_SUBJECT_TOKEN_TYPE` comment above), so it is a literal that
 * must stay byte-identical to the server constant.
 */
const TENANT_SELECTOR_QUERY_PARAM = 'rakomi_tenant_id';

/**
 * Appends the tenant selector to a `resource`/audience string. The server requires it on every
 * workload-identity exchange: it looks up trust policies ONLY in the tenant named here, and rejects a
 * request without a well-formed selector (`invalid_request`). The selector never widens what a token
 * can be minted for — trust-policy verification (signature, subject matchers, scope ceiling) still
 * decides. {@link exchangeOidcSubjectToken} applies it to every request it sends.
 */
export function withOidcFederationTenantSelector(baseResource: string, tenantId: string): string {
  const sep = baseResource.includes('?') ? '&' : '?';
  return `${baseResource}${sep}${TENANT_SELECTOR_QUERY_PARAM}=${encodeURIComponent(tenantId)}`;
}

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
 * MANDATORY on this flow server-side, so a proof is built and sent unconditionally, signed with
 * `opts.dpopKey` — never reused ACROSS PROOFS (`buildDpopProof` mints a fresh `jti` every call),
 * but the underlying KEYPAIR is the caller's choice, so a caller that persists and reuses the same
 * keypair across processes gets a token whose `cnf.jkt` a later process can still prove possession
 * of (see `commands/login.ts`'s `runLoginCi`).
 *
 * `opts.tenantId` is REQUIRED: it names the tenant whose trust policy the runner's token is checked
 * against, and is sent as the `rakomi_tenant_id` selector on `resource`
 * ({@link withOidcFederationTenantSelector}). Callers validate it as a tenant UUID first.
 */
export async function exchangeOidcSubjectToken(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly subjectToken: string;
    readonly resource: string;
    readonly tenantId: string;
    readonly dpopKey: DpopKeyPair;
  },
): Promise<OidcFederationTokenResult> {
  const tokenUrl = `${opts.apiBaseUrl}/oauth/token`;
  const proof = buildDpopProof(opts.dpopKey, { htm: 'POST', htu: canonicalizeHtu(tokenUrl) });

  const result = await request<OidcFederationTokenResult & { error?: string }>(deps, {
    method: 'POST',
    url: tokenUrl,
    headers: { dpop: proof },
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: opts.subjectToken,
      subject_token_type: OIDC_FEDERATION_SUBJECT_TOKEN_TYPE,
      resource: withOidcFederationTenantSelector(opts.resource, opts.tenantId),
    },
  });

  if (result.status !== 200) {
    throw new CliError(`Could not sign in from CI: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
