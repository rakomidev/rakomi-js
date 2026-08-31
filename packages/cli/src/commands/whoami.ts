// SPDX-License-Identifier: MIT

import { NotLoggedInError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { resolveDpopKey } from '../install-key.js';
import type { KeyStore, SessionStore } from '../session.js';
import type { TenantConfigStore } from '../tenant-config.js';
import { fetchUserInfo } from '../userinfo-client.js';

export interface WhoamiDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
  /** Story rakomi-cli-login-identity-first-platform-tenant. */
  readonly tenantConfig: TenantConfigStore;
  /** `--tenant <id>` — a per-invocation override; takes precedence over `tenantConfig.read()` for THIS call only (never persisted). */
  readonly explicitTenant?: string;
}

/**
 * How the active tenant got selected, said plainly. The three states are genuinely different and a
 * user acting on the wrong one is the reason this is not a single string:
 *   • verified — `rakomi use <slug>`: the server confirmed the membership before it was stored.
 *   • remembered — `rakomi use <tenant-id>`: a bare UUID, which cannot be server-verified.
 *   • override — `--tenant <id>`: this invocation only, nothing stored, nothing confirmed.
 */
function describeActiveTenant(
  deps: WhoamiDeps,
  activeTenantId: string | undefined,
): string {
  if (!activeTenantId) return 'none set (run `rakomi use <tenant-slug>`)';
  if (deps.explicitTenant) return `${activeTenantId} (--tenant override for this command only — not verified)`;
  const active = deps.tenantConfig.readActive?.() ?? null;
  if (active && active.tenantId === activeTenantId && active.verifiedViaSlug) {
    return `${activeTenantId} (verified member of "${active.verifiedViaSlug}")`;
  }
  return `${activeTenantId} (remembered locally — membership not verified; re-run \`rakomi use <tenant-slug>\` to verify)`;
}

export async function runWhoami(deps: WhoamiDeps): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const dpop = resolveDpopKey(deps.keys, session);
  const info = await fetchUserInfo(deps, { apiBaseUrl: session.api_base_url, accessToken: session.access_token, dpop });
  const activeTenantId = deps.explicitTenant ?? deps.tenantConfig.read() ?? undefined;

  if (deps.json) {
    deps.stdout.write(
      JSON.stringify({
        sub: info.sub,
        email: info.email,
        org_id: info.org_id,
        org_role: info.org_role,
        session_store: deps.session.describePath(),
        token_type: session.token_type,
        home_tenant_id: session.home_tenant_id,
        active_tenant_id: activeTenantId,
      }) + '\n',
    );
    return;
  }
  const lines = [`Signed in as: ${info.email ?? info.sub}`];
  if (info.org_id) lines.push(`Organization: ${info.org_id}${info.org_role ? ` (${info.org_role})` : ''}`);
  lines.push(`API: ${session.api_base_url}`);
  lines.push(`Home tenant: ${session.home_tenant_id ?? 'unknown (this session did not authenticate via the CIMD-default flow)'}`);
  lines.push(`Active tenant: ${describeActiveTenant(deps, activeTenantId)}`);
  lines.push(`Session stored in: ${deps.session.describePath()}`);
  lines.push(`Token type: ${session.token_type}`);
  deps.stdout.write(lines.join('\n') + '\n');
}
