// SPDX-License-Identifier: MIT

import { randomBytes } from 'node:crypto';

import { CliError, EXIT } from './errors.js';
import { describeError, errorCode, type HttpDeps, request } from './http.js';
import type { StoredInstallKey } from './install-key.js';

/**
 * Must stay byte-identical to the platform's own ephemeral-tenant TTL bounds
 * (`EPHEMERAL_TENANT_TTL_SECONDS_MIN`/`_MAX` in the API's shared constants). This package ships
 * ZERO runtime dependencies (see `env.ts`'s `isCimdClientId` for the same discipline), so these are
 * from-scratch literals kept in sync BY CONVENTION rather than by import — a client-side check here
 * only ever saves a round trip; the server's own bound is what actually decides.
 */
export const EPHEMERAL_TENANT_TTL_SECONDS_MIN = 600;
export const EPHEMERAL_TENANT_TTL_SECONDS_MAX = 1_209_600;

/** Must stay byte-identical to the server's own `tenants_lease_label_length_check`. */
export const EPHEMERAL_LEASE_LABEL_MAX_LENGTH = 200;

export type EphemeralLeaseSource = 'pool' | 'on_demand';

/** Mirrors the server's own `EphemeralLeaseResponse` exactly — see the route's response mapper. */
export interface EphemeralLeaseResult {
  readonly tenant_id: string;
  readonly slug: string;
  readonly expires_at: string;
  /** Identifies this lease for the matching release call — today always equal to `tenant_id`. */
  readonly lease_id: string;
  readonly source: EphemeralLeaseSource;
}

export interface ClaimEphemeralTenantOptions {
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  /** The caller's own tenant — the server 404s (never 403) if this isn't the caller's own tenant id. */
  readonly parentTenantId: string;
  /** Only meaningful when a NEW tenant is created (a pool hit reuses that tenant's own TTL). */
  readonly ttlSeconds?: number;
  readonly label?: string;
  readonly idempotencyKey?: string;
  /** Story rakomi-cli-dpop-token-binding — present IFF the active session is DPoP-bound. */
  readonly dpop?: StoredInstallKey;
}

/** security.md — all security-critical random via `crypto.randomBytes`, never `Math.random()`. */
function generateIdempotencyKey(): string {
  return randomBytes(16).toString('hex');
}

const CHILD_TENANT_LIMIT_REACHED_CODE = 'tenant/child_tenant_limit_reached';

export async function claimEphemeralTenant(deps: HttpDeps, opts: ClaimEphemeralTenantOptions): Promise<EphemeralLeaseResult> {
  const result = await request<EphemeralLeaseResult>(deps, {
    method: 'POST',
    url: `${opts.apiBaseUrl}/v1/tenants/${encodeURIComponent(opts.parentTenantId)}/ephemeral/claims`,
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    body: {
      ...(opts.ttlSeconds !== undefined ? { ttl_seconds: opts.ttlSeconds } : {}),
      ...(opts.label ? { label: opts.label } : {}),
    },
    idempotencyKey: opts.idempotencyKey ?? generateIdempotencyKey(),
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login --ci` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 403) {
    throw new CliError(
      `Could not claim an ephemeral tenant: ${describeError(result.body, result.status)} ` +
        "(missing the `tenants:lease` scope — check this CI identity's trust policy).",
      EXIT.FAIL,
    );
  }
  if (result.status === 404) {
    throw new CliError(
      `Could not claim an ephemeral tenant: ${describeError(result.body, result.status)} ` +
        "(the given tenant is not the caller's own tenant, or the caller's own tenant is itself " +
        'ephemeral — ephemeral tenants cannot nest).',
      EXIT.FAIL,
    );
  }
  if (result.status === 409 && errorCode(result.body) === CHILD_TENANT_LIMIT_REACHED_CODE) {
    throw new CliError(`Could not claim an ephemeral tenant: ${describeError(result.body, result.status)}.`, EXIT.FAIL);
  }
  if (result.status !== 201) {
    throw new CliError(`Could not claim an ephemeral tenant: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
  return result.body;
}

export interface ReleaseEphemeralTenantOptions {
  readonly apiBaseUrl: string;
  readonly accessToken: string;
  readonly parentTenantId: string;
  readonly tenantId: string;
  readonly dpop?: StoredInstallKey;
}

export async function releaseEphemeralTenant(deps: HttpDeps, opts: ReleaseEphemeralTenantOptions): Promise<void> {
  const result = await request(deps, {
    method: 'DELETE',
    url: `${opts.apiBaseUrl}/v1/tenants/${encodeURIComponent(opts.parentTenantId)}/ephemeral/claims/${encodeURIComponent(opts.tenantId)}`,
    headers: opts.dpop ? undefined : { authorization: `Bearer ${opts.accessToken}` },
    dpop: opts.dpop ? { key: opts.dpop, accessToken: opts.accessToken } : undefined,
  });
  if (result.status === 401) {
    throw new CliError('Your session has expired. Run `rakomi login --ci` again.', EXIT.NOT_LOGGED_IN);
  }
  if (result.status === 403) {
    throw new CliError(
      `Could not release the ephemeral tenant: ${describeError(result.body, result.status)} ` +
        "(missing the `tenants:lease` scope — check this CI identity's trust policy).",
      EXIT.FAIL,
    );
  }
  if (result.status === 404) {
    throw new CliError(
      `Could not release the ephemeral tenant: ${describeError(result.body, result.status)} ` +
        '(the given tenant id does not exist under the given parent, or is not an ephemeral tenant).',
      EXIT.FAIL,
    );
  }
  if (result.status !== 204) {
    throw new CliError(`Could not release the ephemeral tenant: ${describeError(result.body, result.status)}`, EXIT.FAIL);
  }
}
