// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';
import type { StoredInstallKey } from './install-key.js';

export interface CimdClientRow {
  readonly id: string;
  readonly client_id: string;
  readonly agent_access: { readonly level: 'read' | 'write' | 'none'; readonly owner_granted: boolean };
}

/**
 * Poll for the oauth_clients row a CIMD client materializes on its first successful authorize.
 * `accessToken` must carry the `clients:read` scope (granted at `rakomi login`).
 */
export async function pollCimdMaterialization(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly accessToken: string;
    readonly cimdUrl: string;
    /** Story rakomi-cli-dpop-token-binding — present IFF the active session is DPoP-bound (`install-key.ts`'s `resolveDpopKey()`). */
    readonly dpop?: StoredInstallKey;
  },
): Promise<CimdClientRow | null> {
  const url = new URL('/v1/oauth-clients', opts.apiBaseUrl);
  url.searchParams.set('cimd_url', opts.cimdUrl);
  const result = await request<{ data: readonly CimdClientRow[] }>(deps, {
    method: 'GET',
    url: url.toString(),
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status !== 200) {
    throw new CliError(`Could not check connection status: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body.data[0] ?? null;
}

/**
 * Request owner-granted `mcp:tools:write` elevation for a materialized OAuth/CIMD client.
 * `accessToken` must carry the `elevation:request` scope AND belong to a caller who is also a
 * registered dashboard member (any role) of the calling tenant — the elevation audit trail names
 * a real human requester, not a machine token (see `elevation_request/requires_tenant_membership`).
 */
export async function requestWriteElevation(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly accessToken: string;
    readonly oauthClientId: string;
    readonly dpop?: StoredInstallKey;
  },
): Promise<void> {
  const result = await request(deps, {
    method: 'POST',
    url: `${opts.apiBaseUrl}/v1/oauth-clients/${encodeURIComponent(opts.oauthClientId)}/elevation-requests`,
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    body: { scopes: ['mcp:tools:write'] },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status !== 201 && result.status !== 200) {
    throw new CliError(`Could not request write access: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
}
