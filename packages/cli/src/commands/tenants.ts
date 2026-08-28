// SPDX-License-Identifier: MIT

import { InteractiveRequiredError, NotLoggedInError, UsageError } from '../errors.js';
import type { HttpDeps } from '../http.js';
import type { SessionStore } from '../session.js';
import { createTenant, listTenants } from '../tenants-client.js';

export interface TenantsCreateDeps extends HttpDeps {
  readonly session: SessionStore;
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
  readonly json: boolean;
  readonly stdout: { write(s: string): void };
}

export async function runTenantsList(deps: TenantsListDeps): Promise<void> {
  const session = deps.session.read();
  if (!session) throw new NotLoggedInError();

  const result = await listTenants(deps, { apiBaseUrl: session.api_base_url, accessToken: session.access_token, parent: 'me' });

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
