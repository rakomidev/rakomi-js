// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CliEnv } from './env.js';
import { configDir } from './session.js';

export interface StoredTenantConfig {
  readonly active_tenant_id: string;
  /**
   * The slug whose membership the SERVER confirmed when this value was written (`rakomi use <slug>`).
   * ABSENT for the `rakomi use <tenant-id>` path, and absent for every file written before the marker existed — both
   * of which read back as "not verified", which is the correct and fail-closed reading.
   */
  readonly verified_via_slug?: string;
}

/** What `read()` returns: the id, plus how it got there. */
export interface ActiveTenant {
  readonly tenantId: string;
  /** `undefined` ⇒ a locally-remembered value the server never confirmed. */
  readonly verifiedViaSlug?: string;
}

/** Injectable store — the real implementation is `FileTenantConfigStore`; tests use an in-memory fake. */
export interface TenantConfigStore {
  /** `null` when nothing is stored, or the stored value is unreadable/corrupted (fail-closed, same doctrine as `SessionStore.read()`). */
  read(): string | null;
  /** The full record. `null` under the same conditions as `read()`. */
  readActive?(): ActiveTenant | null;
  write(tenantId: string, verifiedViaSlug?: string): void;
  clear(): void;
}

function isStoredTenantConfig(value: unknown): value is StoredTenantConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.active_tenant_id !== 'string' || v.active_tenant_id.length === 0) return false;
  return v.verified_via_slug === undefined || typeof v.verified_via_slug === 'string';
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
    return this.readActive()?.tenantId ?? null;
  }

  readActive(): ActiveTenant | null {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredTenantConfig(parsed)) return null;
      return parsed.verified_via_slug !== undefined && parsed.verified_via_slug.length > 0
        ? { tenantId: parsed.active_tenant_id, verifiedViaSlug: parsed.verified_via_slug }
        : { tenantId: parsed.active_tenant_id };
    } catch {
      return null;
    }
  }

  write(tenantId: string, verifiedViaSlug?: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const config: StoredTenantConfig =
      verifiedViaSlug !== undefined && verifiedViaSlug.length > 0
        ? { active_tenant_id: tenantId, verified_via_slug: verifiedViaSlug }
        : { active_tenant_id: tenantId };
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
