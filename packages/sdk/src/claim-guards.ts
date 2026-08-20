
import type { OrgMembership, TokenPayload } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function guardStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function guardOrgIdOrRole(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string') return value;
  return undefined;
}

/** A non-array input omits the claim entirely; a valid array's non-string entries are dropped. */
export function guardRoles(value: unknown): string[] | undefined {
  return guardStringArray(value);
}

/** A non-array input omits the claim entirely; a valid array's non-string entries are dropped. */
export function guardPermissions(value: unknown): string[] | undefined {
  return guardStringArray(value);
}

/** A non-array input omits the claim entirely; a valid array's non-string entries are dropped. */
export function guardAmr(value: unknown): string[] | undefined {
  return guardStringArray(value);
}

/** A non-string input omits the claim. */
export function guardAcr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `string | null` is accepted; any other type omits the claim. */
export function guardOrgId(value: unknown): string | null | undefined {
  return guardOrgIdOrRole(value);
}

/** `string | null` is accepted; any other type omits the claim. */
export function guardOrgRole(value: unknown): string | null | undefined {
  return guardOrgIdOrRole(value);
}

/**
 * A non-array input omits the whole claim. Each entry in a valid array is independently shape-checked
 * (`org_id`/`org_slug`/`org_role` as `string`; `membership_public_metadata`, when present, a plain
 * object or `null` — `null` is accepted defensively, mirroring `org_id`/`org_role`'s own explicit
 * null-acceptance, since the field is a legitimate "no metadata" state on the write side) — an entry
 * failing this check is dropped from the array, not the whole claim. An all-valid array of `[]` length
 * stays `[]`, distinct from "claim absent". The returned entry is reconstructed from only the validated
 * fields — an unexpected extra property on the raw entry does not ride through unfiltered.
 */
export function guardOrgMemberships(value: unknown): OrgMembership[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: OrgMembership[] = [];
  for (const m of value) {
    if (m == null || typeof m !== 'object') continue;
    const entry = m as Record<string, unknown>;
    const { org_id, org_slug, org_role } = entry;
    if (typeof org_id !== 'string') continue;
    if (typeof org_slug !== 'string') continue;
    if (typeof org_role !== 'string') continue;
    const meta = entry['membership_public_metadata'];
    if (!(meta === undefined || meta === null || isPlainObject(meta))) continue;
    result.push({
      org_id,
      org_slug,
      org_role,
      ...(meta !== undefined ? { membership_public_metadata: meta as Record<string, unknown> | null } : {}),
    } as OrgMembership);
  }
  return result;
}

/** A value that is not a plain object (array, `null`, or a primitive) omits the claim. */
export function guardPublicMetadata(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

/**
 * All four required fields must match their published type, or the entire claim is omitted — no
 * partial `subscription` is ever returned (a half-populated subscription is not a meaningful state).
 */
export function guardSubscription(value: unknown): TokenPayload['subscription'] | undefined {
  if (!isPlainObject(value)) return undefined;
  const { plan_id, plan_name, status, current_period_end } = value;
  if (
    typeof plan_id !== 'string' ||
    typeof plan_name !== 'string' ||
    typeof status !== 'string' ||
    !(current_period_end === null || typeof current_period_end === 'string')
  ) {
    return undefined;
  }
  return { plan_id, plan_name, status, current_period_end };
}
