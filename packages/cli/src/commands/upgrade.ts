// SPDX-License-Identifier: MIT

import { getBillingPlan } from '../billing-client.js';
import type { BrowserOpener } from '../browser.js';
import { NotLoggedInError, UsageError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { resolveDpopKey } from '../install-key.js';
import type { KeyStore, SessionStore } from '../session.js';
import type { TenantConfigStore } from '../tenant-config.js';

export interface UpgradeDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly tenantConfig: TenantConfigStore;
  /** `--tenant <id>` — a per-invocation override, same precedence as `whoami`'s. */
  readonly explicitTenant?: string;
  readonly openBrowser: BrowserOpener;
  readonly stdout: { write(s: string): void };
}

export async function runUpgrade(deps: UpgradeDeps): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const tenantId = deps.explicitTenant ?? deps.tenantConfig.read() ?? undefined;
  if (!tenantId) {
    throw new UsageError('No active tenant set. Run `rakomi use <tenant-slug>` first, or pass --tenant <id>.');
  }

  const dpop = resolveDpopKey(deps.keys, session);
  const plan = await getBillingPlan(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    tenantId,
    dpop,
  });

  deps.stdout.write(`Current plan: ${plan.effective_plan}\nOpening ${plan.upgrade_url} in your browser...\n`);
  await deps.openBrowser(plan.upgrade_url);
}
