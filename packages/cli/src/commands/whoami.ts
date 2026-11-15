// SPDX-License-Identifier: MIT

import { CI_FEDERATION_SESSION_CLIENT_ID } from '../env.js';
import { CliError, EXIT, NotLoggedInError } from '../errors.js';
import { describeError, type HttpDeps, request } from '../http.js';
import { resolveDpopKey, type StoredInstallKey } from '../install-key.js';
import type { KeyStore, SessionStore, StoredSession } from '../session.js';
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
  /**
   * Story cli-silent-token-refresh-and-whoami-honesty — injectable clock for the LOCAL
   * expiry/status computation below (`describeTokenStatus`), same idiom as `login.ts`'s `now`.
   * Defaults to `Date.now` so every pre-existing `WhoamiDeps` fixture in the test suite keeps
   * compiling unchanged.
   */
  readonly now?: () => number;
}

/**
 * `valid`/`expired`, computed ENTIRELY from the LOCAL `expires_at` this CLI already persisted at
 * login/refresh — no network round trip is made (or needed) to answer this. `whoami` used to give
 * no local answer to "is my session still good" at all, leaving the live `fetchUserInfo` call below
 * as the only signal — which meant a session could read as fine right up to the 401 that a
 * network-degraded/interactive-less invocation might not even surface clearly. `expired` is not a
 * dead end any more (see `token-refresh.ts`): the NEXT authenticated call this CLI makes silently
 * refreshes it, which is why the message says so rather than telling the user to `rakomi login` again.
 */
function describeTokenStatus(expiresAt: number, now: number): string {
  return now >= expiresAt ? 'expired (will auto-refresh on next use)' : 'valid';
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

/** What `GET /v1/oidc-federation/session` answers for a CI workload-identity session (the server verified the token). */
export interface CiSessionIdentity {
  readonly tenant_id: string;
  readonly environment: string;
  readonly trust_policy_id: string;
  readonly trust_policy_name: string;
  readonly ci_subject: string | null;
  readonly scope: string;
}

/** A value the server returned, made safe to print: control characters (ANSI escapes, newlines) removed, at most 256. */
export function printable(value: string | null | undefined): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256);
}

/**
 * Asks the API what this CI session's token is for. A CI token has no end user, so `/oauth/userinfo` (the interactive
 * whoami's source) has nothing to answer for it; `GET /v1/oidc-federation/session` does, from a token the server verified
 * (signature, issuer, audience, expiry, the DPoP proof, the trust policy still enabled). Nothing printed comes from the CLI
 * decoding its own token.
 */
export async function fetchCiSession(deps: HttpDeps, session: StoredSession, dpop: StoredInstallKey | undefined): Promise<CiSessionIdentity> {
  const result = await request<CiSessionIdentity & { code?: string }>(deps, {
    method: 'GET',
    url: `${session.api_base_url}/v1/oidc-federation/session`,
    headers: dpop ? undefined : { authorization: `Bearer ${session.access_token}` },
    dpop: dpop ? { key: dpop, accessToken: session.access_token } : undefined,
  });
  if (result.status === 401) throw new CliError('Your CI session has expired or was refused. Run `rakomi login --ci` again.', EXIT.NOT_LOGGED_IN);
  if (result.status === 404) throw new CliError('The API does not recognise this CI session (its trust policy is disabled or gone). Run `rakomi login --ci` again.', EXIT.NOT_LOGGED_IN);
  if (result.status !== 200) throw new CliError(`Could not describe the CI session: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  const b = result.body;
  if (typeof b.tenant_id !== 'string' || typeof b.environment !== 'string' || typeof b.trust_policy_id !== 'string') {
    throw new CliError('The API answered the CI session check without a tenant, environment or trust policy.', EXIT.FAIL);
  }
  return b;
}

async function runWhoamiCi(deps: WhoamiDeps, session: StoredSession): Promise<void> {
  const identity = await fetchCiSession(deps, session, resolveDpopKey(deps.keys, session));
  const now = (deps.now ?? Date.now)();
  const tokenStatus = now >= session.expires_at ? 'expired (run `rakomi login --ci` again)' : 'valid';
  const view = {
    tenant_id: printable(identity.tenant_id),
    environment: printable(identity.environment),
    trust_policy_id: printable(identity.trust_policy_id),
    trust_policy_name: printable(identity.trust_policy_name),
    ci_subject: identity.ci_subject === null ? null : printable(identity.ci_subject),
    scope: printable(identity.scope),
  };
  if (deps.json) {
    deps.stdout.write(
      JSON.stringify({
        session_kind: 'ci_workload_identity',
        ...view,
        verified_by: 'server',
        api_base_url: session.api_base_url,
        session_store: deps.session.describePath(),
        token_type: session.token_type,
        expires_at: new Date(session.expires_at).toISOString(),
        token_status: tokenStatus,
      }) + '\n',
    );
    return;
  }
  const lines = [
    `Signed in as: CI workload identity${view.ci_subject ? ` ${view.ci_subject}` : ''}`,
    `Workspace (tenant): ${view.tenant_id}`,
    `Environment: ${view.environment}`,
    `Trust policy: ${view.trust_policy_name} (${view.trust_policy_id})`,
    `Scopes: ${view.scope || '(none)'}`,
    `API: ${session.api_base_url} (checked by the server just now)`,
    `Session stored in: ${deps.session.describePath()}`,
    `Token type: ${session.token_type}`,
    `Token expires: ${new Date(session.expires_at).toISOString()} (${tokenStatus})`,
  ];
  deps.stdout.write(lines.join('\n') + '\n');
}

export async function runWhoami(deps: WhoamiDeps): Promise<void> {
  const initialSession = deps.session.read();
  if (!initialSession) throw new NotLoggedInError();
  if (initialSession.client_id === CI_FEDERATION_SESSION_CLIENT_ID) {
    await runWhoamiCi(deps, initialSession);
    return;
  }

  const dpop = resolveDpopKey(deps.keys, initialSession);
  const info = await fetchUserInfo(deps, { apiBaseUrl: initialSession.api_base_url, accessToken: initialSession.access_token, dpop });
  const session = deps.session.read() ?? initialSession;
  const now = (deps.now ?? Date.now)();
  const tokenStatus = describeTokenStatus(session.expires_at, now);
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
        expires_at: new Date(session.expires_at).toISOString(),
        token_status: tokenStatus,
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
  lines.push(`Token expires: ${new Date(session.expires_at).toISOString()} (${tokenStatus})`);
  deps.stdout.write(lines.join('\n') + '\n');
}
