// SPDX-License-Identifier: MIT

import { randomBytes } from 'node:crypto';

import { CliError, EXIT } from './errors.js';
import { describeError, errorCode, type HttpDeps, request } from './http.js';
import type { StoredInstallKey } from './install-key.js';

export type TenantStatus = 'pending_owner_acceptance' | 'active' | 'suspended';

/** The ONLY shape a parent ever sees about a tenant it provisioned — mirrors the server's own
 * response mapper exactly (`{id, slug, name, status, created_at, plan_tier}` — no
 * `parent_tenant_id`). */
export interface TenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly created_at: string;
  readonly plan_tier: string;
}

/** Mirrors `ProvisionedTenantResponse` exactly — EXACTLY ONE of `owner_invitation` (M2M/partner
 * path) / `api_key` (self-owner path) is ever present, never both, never neither. */
export interface CreateTenantResult {
  readonly tenant: TenantSummary;
  readonly owner_invitation?: { readonly expires_at: string };
  readonly api_key?: { readonly id: string; readonly prefix: string; readonly key: string };
}

export interface CreateTenantOptions {
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  readonly name: string;
  readonly slug?: string;
  /** OMIT for the self-owner path (`--owner me`) — the caller becomes the owner directly. Set
   * ONLY for a third-party owner hand-off, which requires a partner client_credentials token. */
  readonly ownerEmail?: string;
  readonly idempotencyKey?: string;
  /** Story rakomi-cli-dpop-token-binding — present IFF the active session is DPoP-bound. */
  readonly dpop?: StoredInstallKey;
}

/** The exact, known 403 code the real endpoint returns for a caller who is neither
 * `client_credentials` nor a verified owner of the calling tenant — see
 * `create-child-tenant-route.ts` / `list-child-tenants-route.ts` / `tenants-caller-kind.ts`. */
const M2M_OR_OWNER_REQUIRED_CODE = 'tenant/owner_grant_requires_m2m_caller';
/** The self-owner path (no `owner_email`) rejects a caller-supplied `owner_email` outright. */
const OWNER_EMAIL_NOT_ALLOWED_CODE = 'tenant/owner_email_not_allowed_for_self_owner';

/** security.md — all security-critical random via `crypto.randomBytes`, never `Math.random()`. */
export function generateIdempotencyKey(): string {
  return randomBytes(16).toString('hex');
}

function describeCallerRejected(action: 'create the tenant' | 'list tenants'): string {
  return (
    `Could not ${action}: you are signed in, but you are not a verified owner of the tenant this ` +
    'session belongs to (and this is not a partner client_credentials token either). Ask your ' +
    'tenant\'s owner to run this, or integrate directly against `POST/GET /v1/tenants` with your ' +
    'own partner client_credentials.'
  );
}

export async function createTenant(deps: HttpDeps, opts: CreateTenantOptions): Promise<CreateTenantResult> {
  const result = await request<CreateTenantResult>(deps, {
    method: 'POST',
    url: `${opts.apiBaseUrl}/v1/tenants`,
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    body: { name: opts.name, ...(opts.slug ? { slug: opts.slug } : {}), ...(opts.ownerEmail ? { owner_email: opts.ownerEmail } : {}) },
    idempotencyKey: opts.idempotencyKey ?? generateIdempotencyKey(),
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 400 && errorCode(result.body) === OWNER_EMAIL_NOT_ALLOWED_CODE) {
    throw new CliError(
      'Could not create the tenant: --owner <email> (a third-party owner) requires a partner ' +
        'client_credentials integration — use --owner me from an interactive session.',
      EXIT.FAIL,
    );
  }
  if (result.status === 403) {
    if (errorCode(result.body) === M2M_OR_OWNER_REQUIRED_CODE) {
      throw new CliError(describeCallerRejected('create the tenant'), EXIT.FAIL);
    }
    throw new CliError(
      `Could not create the tenant: ${describeError(result.body, result.status)} ` +
        '(missing the `tenants:create` scope, or the caller tenant already has a parent — depth-1 only).',
      EXIT.FAIL,
    );
  }
  if (result.status !== 201) {
    throw new CliError(`Could not create the tenant: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}

/** Mirrors `GET /v1/tenants`'s real `{ data: ChildTenantResponse[] }` — there is no `pagination`
 * envelope; the route always returns the caller's full child set in one page. */
export interface ListTenantsResult {
  readonly data: readonly TenantSummary[];
}

export async function listTenants(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly accessToken: string;
    readonly parent?: 'me';
    readonly dpop?: StoredInstallKey;
  },
): Promise<ListTenantsResult> {
  const url = new URL('/v1/tenants', opts.apiBaseUrl);
  if (opts.parent) url.searchParams.set('parent', opts.parent);
  const result = await request<ListTenantsResult>(deps, {
    method: 'GET',
    url: url.toString(),
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 403) {
    if (errorCode(result.body) === M2M_OR_OWNER_REQUIRED_CODE) {
      throw new CliError(describeCallerRejected('list tenants'), EXIT.FAIL);
    }
    throw new CliError(`Could not list tenants: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  if (result.status !== 200) {
    throw new CliError(`Could not list tenants: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}

/** Mirrors the server's `TenantMembershipResponse` exactly — `{id, slug, name, role}`, nothing
 * about a tenant the caller is not a verified member of. */
export interface TenantMembership {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: string;
}

export interface ListTenantMembershipsResult {
  readonly data: readonly TenantMembership[];
}

function describeCallerUnverified(action: 'list your tenant memberships' | 'look up this tenant membership'): string {
  return (
    `Could not ${action}: your account e-mail is not verified (or is disabled). Verify your e-mail ` +
    'and sign in again.'
  );
}

export async function listTenantMemberships(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly accessToken: string;
    readonly dpop?: StoredInstallKey;
  },
): Promise<ListTenantMembershipsResult> {
  const result = await request<ListTenantMembershipsResult>(deps, {
    method: 'GET',
    url: `${opts.apiBaseUrl}/v1/tenants/memberships`,
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 403) {
    throw new CliError(describeCallerUnverified('list your tenant memberships'), EXIT.FAIL);
  }
  if (result.status !== 200) {
    throw new CliError(`Could not list your tenant memberships: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}

/** `rakomi use <slug>` — resolves ONE membership by slug through a single verified round trip
 * (`tenants.slug` is globally unique, so there is never an "ambiguous slug" case to design for).
 * Returns `null` on 404 — the caller (`runUse`) turns that into a `UsageError` naming only the
 * slug the user already typed, never confirming whether the slug exists at all. */
export async function getTenantMembershipBySlug(
  deps: HttpDeps,
  opts: {
    readonly apiBaseUrl: string;
    readonly accessToken: string;
    readonly slug: string;
    readonly dpop?: StoredInstallKey;
  },
): Promise<TenantMembership | null> {
  const result = await request<TenantMembership>(deps, {
    method: 'GET',
    url: `${opts.apiBaseUrl}/v1/tenants/memberships/${encodeURIComponent(opts.slug)}`,
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 404) {
    return null;
  }
  if (result.status === 403) {
    throw new CliError(describeCallerUnverified('look up this tenant membership'), EXIT.FAIL);
  }
  if (result.status !== 200) {
    throw new CliError(`Could not look up tenant "${opts.slug}": ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}
