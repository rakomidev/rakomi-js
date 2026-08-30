// SPDX-License-Identifier: MIT

import { InteractiveRequiredError, NotLoggedInError, UsageError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import { resolveDpopKey } from '../install-key.js';
import {
  claimEphemeralTenant,
  EPHEMERAL_LEASE_LABEL_MAX_LENGTH,
  EPHEMERAL_TENANT_TTL_SECONDS_MAX,
  EPHEMERAL_TENANT_TTL_SECONDS_MIN,
  releaseEphemeralTenant,
} from '../lease-client.js';
import type { KeyStore, SessionStore } from '../session.js';
import type { TenantConfigStore } from '../tenant-config.js';
import { createTenant, listTenantMemberships, listTenants } from '../tenants-client.js';

export interface TenantsCreateDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly ci: boolean;
  readonly stdout: { write(s: string): void };
}

export interface TenantsCreateArgs {
  readonly name: string;
  readonly slug?: string;
  /** `'me'` (default) or an explicit e-mail. */
  readonly owner: string;
}

export async function runTenantsCreate(deps: TenantsCreateDeps, args: TenantsCreateArgs): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const ownerIsSelf = args.owner === 'me';
  if (!ownerIsSelf && !args.owner.includes('@')) {
    throw new UsageError(`--owner must be "me" or an e-mail address, got "${args.owner}"`);
  }

  if (!ownerIsSelf && deps.ci) {
    throw new InteractiveRequiredError(
      '`tenants create --owner <email>` (a third-party owner) requires interactive confirmation; use --owner me under --ci.',
    );
  }

  if (deps.dryRun) {
    deps.stdout.write(
      ownerIsSelf
        ? `Would create tenant "${args.name}"${args.slug ? ` (slug: ${args.slug})` : ''} with yourself as owner (self-owner — mints an API key). No request sent (--dry-run).\n`
        : `Would create tenant "${args.name}"${args.slug ? ` (slug: ${args.slug})` : ''} with owner ${args.owner}. No request sent (--dry-run).\n`,
    );
    return;
  }

  const result = await createTenant(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    name: args.name,
    slug: args.slug,
    ownerEmail: ownerIsSelf ? undefined : args.owner,
    dpop: resolveDpopKey(deps.keys, session),
  });

  if (deps.json) {
    deps.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const lines = [`Created tenant "${result.tenant.slug}" (${result.tenant.id}) — status: ${result.tenant.status}`];
  if (result.api_key) {
    lines.push(`You are the owner. API key (shown ONLY this once — save it now): ${result.api_key.key}`);
  } else if (result.owner_invitation) {
    lines.push(`An owner invitation was sent to ${args.owner} (expires ${result.owner_invitation.expires_at}).`);
  }
  deps.stdout.write(lines.join('\n') + '\n');
}

export interface TenantsListDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
}

export async function runTenantsList(deps: TenantsListDeps): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const result = await listTenants(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    parent: 'me',
    dpop: resolveDpopKey(deps.keys, session),
  });

  if (deps.json) {
    deps.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (result.data.length === 0) {
    deps.stdout.write('No provisioned tenants.\n');
    return;
  }
  deps.stdout.write(result.data.map((t) => `${t.slug}\t${t.id}\t${t.status}`).join('\n') + '\n');
}

export interface TenantsMembershipsDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
}

/** `rakomi tenants memberships` — the tenants the caller's verified identity is a MEMBER of
 * (`GET /v1/tenants/memberships`), a completely different population from `rakomi tenants list`'s
 * "tenants you provisioned" — see `tenants-client.ts`'s module header for why the two are
 * deliberately separate verbs, not a repurposed `list`. */
export async function runTenantsMemberships(deps: TenantsMembershipsDeps): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const result = await listTenantMemberships(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    dpop: resolveDpopKey(deps.keys, session),
  });

  if (deps.json) {
    deps.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (result.data.length === 0) {
    deps.stdout.write('No tenant memberships found for your account.\n');
    return;
  }
  deps.stdout.write(result.data.map((m) => `${m.slug}\t${m.id}\t${m.role}`).join('\n') + '\n');
}

/**
 * Resolves which tenant to claim/release under: an explicit `--tenant <id>` wins for THIS
 * invocation only; otherwise falls back to whatever `rakomi use` remembered locally
 * (`tenant-config.ts` — a VALUE, never a verified membership, same doctrine as `whoami`'s "Active
 * tenant"). `undefined` means neither was given — the caller turns that into an actionable error.
 */
function resolveParentTenantId(explicit: string | undefined, tenantConfig: TenantConfigStore): string | undefined {
  return explicit ?? tenantConfig.read() ?? undefined;
}

const NO_PARENT_TENANT_MESSAGE =
  'No tenant to operate on — pass --tenant <tenant-id>, or run `rakomi use <tenant-id>` first.';

export interface TenantsClaimDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly tenantConfig: TenantConfigStore;
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
}

export interface TenantsClaimArgs {
  /** `--tenant <id>` — the caller's own tenant to claim an ephemeral child under. */
  readonly parentTenantId?: string;
  readonly ttlSeconds?: number;
  readonly label?: string;
}

/**
 * `rakomi tenants claim --ci` — claims one ephemeral (throwaway, TTL-bounded) tenant under the
 * caller's own tenant, over the SAME `--ci` session `rakomi login --ci` already established (this
 * capability is audienced to the platform/API resource, exactly like `tenants create`/`tenants
 * list` — no separate token exchange, unlike `mcp tools --ci`). Dispatch-gated on the literal
 * `--ci` flag (`index.ts`) — there is no interactive counterpart yet.
 */
export async function runTenantsClaim(deps: TenantsClaimDeps, args: TenantsClaimArgs): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError('Not logged in. Run `rakomi login --ci` first.');

  const parentTenantId = resolveParentTenantId(args.parentTenantId, deps.tenantConfig);
  if (!parentTenantId) throw new UsageError(NO_PARENT_TENANT_MESSAGE);

  if (
    args.ttlSeconds !== undefined &&
    (args.ttlSeconds < EPHEMERAL_TENANT_TTL_SECONDS_MIN || args.ttlSeconds > EPHEMERAL_TENANT_TTL_SECONDS_MAX)
  ) {
    throw new UsageError(
      `--ttl-seconds must be between ${EPHEMERAL_TENANT_TTL_SECONDS_MIN} and ${EPHEMERAL_TENANT_TTL_SECONDS_MAX}, got ${args.ttlSeconds}`,
    );
  }

  const label = args.label?.trim();
  if (args.label !== undefined && (label === '' || (label?.length ?? 0) > EPHEMERAL_LEASE_LABEL_MAX_LENGTH)) {
    throw new UsageError(`--label must be 1-${EPHEMERAL_LEASE_LABEL_MAX_LENGTH} characters after trimming, got "${args.label}"`);
  }

  const result = await claimEphemeralTenant(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    parentTenantId,
    ttlSeconds: args.ttlSeconds,
    label,
    dpop: resolveDpopKey(deps.keys, session),
  });

  if (deps.json) {
    deps.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  deps.stdout.write(
    `Claimed ephemeral tenant "${result.slug}" (${result.tenant_id}) — expires ${result.expires_at} (source: ${result.source})\n` +
      `Lease id: ${result.lease_id} — pass this to \`rakomi tenants release --ci\` when you're done with it.\n`,
  );
}

export interface TenantsReleaseDeps extends HttpDeps {
  readonly session: SessionStore;
  readonly keys: KeyStore;
  readonly tenantConfig: TenantConfigStore;
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
}

export interface TenantsReleaseArgs {
  /** The ephemeral tenant's id (== its `lease_id`, from a prior `tenants claim` response) to release. */
  readonly tenantId: string;
  /** `--tenant <id>` — the caller's own tenant it was claimed under. */
  readonly parentTenantId?: string;
}

/**
 * `rakomi tenants release --ci` — schedules an ephemeral tenant for immediate deletion by the same
 * reaper that would otherwise TTL-expire it, over the SAME `--ci` session `tenants claim` used.
 * Never a data wipe, never a return-to-pool — the underlying capability always deletes and, if the
 * pool is below its target size, replenishes separately. Dispatch-gated on `--ci` (`index.ts`).
 */
export async function runTenantsRelease(deps: TenantsReleaseDeps, args: TenantsReleaseArgs): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError('Not logged in. Run `rakomi login --ci` first.');

  const parentTenantId = resolveParentTenantId(args.parentTenantId, deps.tenantConfig);
  if (!parentTenantId) throw new UsageError(NO_PARENT_TENANT_MESSAGE);

  await releaseEphemeralTenant(deps, {
    apiBaseUrl: session.api_base_url,
    accessToken: session.access_token,
    parentTenantId,
    tenantId: args.tenantId,
    dpop: resolveDpopKey(deps.keys, session),
  });

  if (deps.json) {
    deps.stdout.write(JSON.stringify({ released: true, tenant_id: args.tenantId }) + '\n');
    return;
  }
  deps.stdout.write(`Released ephemeral tenant ${args.tenantId} — deletion scheduled.\n`);
}
