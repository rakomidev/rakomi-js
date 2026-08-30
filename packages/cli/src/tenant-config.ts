// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CliEnv } from './env.js';
import { configDir } from './session.js';

export interface StoredTenantConfig {
  readonly active_tenant_id: string;
}

/** Injectable store — the real implementation is `FileTenantConfigStore`; tests use an in-memory fake. */
export interface TenantConfigStore {
  /** `null` when nothing is stored, or the stored value is unreadable/corrupted (fail-closed, same doctrine as `SessionStore.read()`). */
  read(): string | null;
  write(tenantId: string): void;
  clear(): void;
}

function isStoredTenantConfig(value: unknown): value is StoredTenantConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.active_tenant_id === 'string' && v.active_tenant_id.length > 0;
}

function tenantConfigFilePath(env: CliEnv): string {
  return join(configDir(env), 'tenant.json');
}

/** Real, on-disk store: a plain JSON file next to `session.json` (see the module doc for why this is NOT keychain-backed). */
export class FileTenantConfigStore implements TenantConfigStore {
  private readonly path: string;
  private readonly dir: string;

  constructor(env: CliEnv) {
    this.dir = configDir(env);
    this.path = tenantConfigFilePath(env);
  }

  read(): string | null {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isStoredTenantConfig(parsed) ? parsed.active_tenant_id : null;
    } catch {
      return null;
    }
  }

  write(tenantId: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const config: StoredTenantConfig = { active_tenant_id: tenantId };
    writeFileSync(this.path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
    }
  }

  clear(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
    }
  }

  describePath(): string {
    return this.path;
  }
}
