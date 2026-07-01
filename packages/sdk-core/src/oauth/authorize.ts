/**
 * OAuth authorization-URL builder. Pure — no I/O, no platform deps.
 */

export interface BuildAuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope?: string;
  /** Provider hint, e.g. `provider=google`. Server routes to the correct social provider. */
  provider?: string;
  /** Optional `acr_values` for RFC 9470 step-up. */
  acrValues?: string;
  /** RFC 9396 Rich Authorization Requests (forward-compat). */
  authorizationDetails?: Record<string, unknown>;
  extra?: Record<string, string>;
}

export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
  });
  if (input.scope) params.set('scope', input.scope);
  if (input.provider) params.set('provider', input.provider);
  if (input.acrValues) params.set('acr_values', input.acrValues);
  if (input.authorizationDetails) {
    params.set('authorization_details', JSON.stringify(input.authorizationDetails));
  }
  if (input.extra) {
    for (const [k, v] of Object.entries(input.extra)) params.set(k, v);
  }
  const sep = input.authorizationEndpoint.includes('?') ? '&' : '?';
  return `${input.authorizationEndpoint}${sep}${params.toString()}`;
}
