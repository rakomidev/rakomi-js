// SPDX-License-Identifier: MIT

import { CliError, EXIT } from './errors.js';
import { describeError, type HttpDeps, request } from './http.js';
import type { StoredInstallKey } from './install-key.js';

/** Only the fields `rakomi upgrade` needs — the real response carries far more (limits, features,
 * usage). Extra server fields are ignored, never validated away. */
export interface BillingPlanSummary {
  readonly plan: string;
  readonly effective_plan: string;
  readonly upgrade_url: string;
}

export async function getBillingPlan(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly accessToken: string;
    readonly tenantId: string;
    /** Story rakomi-cli-dpop-token-binding — present IFF the active session is DPoP-bound. */
    readonly dpop?: StoredInstallKey;
  },
): Promise<BillingPlanSummary> {
  const url = new URL(`/v1/tenants/${encodeURIComponent(opts.tenantId)}/billing/plan`, opts.apiBaseUrl);
  const result = await request<BillingPlanSummary>(deps, {
    method: 'GET',
    url: url.toString(),
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 404) {
    throw new CliError(
      `Could not fetch your billing plan: tenant ${opts.tenantId} was not found, or you are not one of its owners. ` +
        'Run `rakomi tenants memberships` to see your tenants and roles.',
      EXIT.FAIL,
    );
  }
  if (result.status !== 200) {
    throw new CliError(`Could not fetch your billing plan: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
