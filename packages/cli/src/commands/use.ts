// SPDX-License-Identifier: MIT

import { isValidTenantId } from '../env.js';
import { UsageError } from '../errors.js';
import type { TenantConfigStore } from '../tenant-config.js';

export interface UseDeps {
  readonly tenantConfig: TenantConfigStore;
  readonly stdout: { write(s: string): void };
}

export interface UseArgs {
  readonly tenantId: string;
}

export function runUse(deps: UseDeps, args: UseArgs): void {
  if (!isValidTenantId(args.tenantId)) {
    throw new UsageError(
      `"${args.tenantId}" is not a valid tenant id — expected a UUID (e.g. the value \`rakomi login\` ` +
        'printed as "Home tenant", or the id shown in the dashboard).',
    );
  }
  deps.tenantConfig.write(args.tenantId);
  deps.stdout.write(`Active tenant set to ${args.tenantId}.\n`);
}
