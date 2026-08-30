// SPDX-License-Identifier: MIT

import { isValidTenantId } from '../env.js';
import { NotLoggedInError, UsageError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { resolveDpopKey } from '../install-key.js';
import type { KeyStore, SessionStore } from '../session.js';
import type { TenantConfigStore } from '../tenant-config.js';
import { getTenantMembershipBySlug } from '../tenants-client.js';

export interface UseDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly tenantConfig: TenantConfigStore;
  readonly stdout: { write(s: string): void };
}

export interface UseArgs {
  readonly tenantId: string;
}

export async function runUse(deps: UseDeps, args: UseArgs): Promise<void> {
  if (isValidTenantId(args.tenantId)) {
    deps.tenantConfig.write(args.tenantId);
    deps.stdout.write(`Active tenant set to ${args.tenantId}.\n`);
    return;
  }

  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const membership = await getTenantMembershipBySlug(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    slug: args.tenantId,
    dpop: resolveDpopKey(deps.keys, session),
  });
  if (!membership) {
    throw new UsageError(
      `No tenant membership found for "${args.tenantId}" — check the spelling, or ask a tenant ` +
        'admin to invite you. (Run `rakomi tenants memberships` to see the tenants you already belong to.)',
    );
  }

  deps.tenantConfig.write(membership.id);
  deps.stdout.write(`Active tenant set to ${membership.slug} (${membership.id}) — role: ${membership.role}.\n`);
}
