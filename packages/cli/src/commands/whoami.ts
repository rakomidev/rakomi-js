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
  lines.push(`Active tenant: ${activeTenantId ?? 'none set (run `rakomi use <tenant-id>`)'}`);
  lines.push(`Session stored in: ${deps.session.describePath()}`);
  lines.push(`Token type: ${session.token_type}`);
  deps.stdout.write(lines.join('\n') + '\n');
}
