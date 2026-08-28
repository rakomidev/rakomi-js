
/**
 * A single org membership entry from the `org_memberships` JWT claim.
 * A claim of unexpected shape is treated as absent, never returned malformed.
 * `membership_public_metadata` accepts `null` as an explicit "no metadata" state, distinct from the
 * field being absent — mirroring `org_id`/`org_role`'s own null-acceptance below.
 * Not to be confused with `OrgMembership` (the pre-existing, structurally different type in
 * `types/auth.ts`, used by the `OrgContext`/session surface).
 */
export interface OrgMembershipClaim {
  org_id: string;
  org_slug: string;
  org_role: string;
  membership_public_metadata?: Record<string, unknown> | null;
}

/** Validated `org` scope claims extracted from a decoded JWT payload. */
export interface OrgClaims {
  org_id: string | null | undefined;
  org_role: string | null | undefined;
  org_memberships: OrgMembershipClaim[] | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function guardOrgIdOrRole(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string') return value;
  return undefined;
}

function guardOrgMemberships(value: unknown): OrgMembershipClaim[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: OrgMembershipClaim[] = [];
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
    } as OrgMembershipClaim);
  }
  return result;
}

function isDevMode(): boolean {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.['NODE_ENV'] !== 'production';
}

function describeClaimType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

const warnedClaimNames = new Set<string>();
function warnMalformedClaim(claimName: string, expected: string, actualType: string): void {
  if (!isDevMode()) return;
  if (warnedClaimNames.has(claimName)) return;
  warnedClaimNames.add(claimName);
  console.warn(
    `[@rakomi/sdk-core] Malformed JWT claim "${claimName}": expected ${expected}, got ${actualType}. Claim omitted.`,
  );
}

function warnIfScalarDropped(claimName: string, raw: unknown, guarded: unknown, expected: string): void {
  if (raw === undefined || raw === null) return;
  if (guarded === undefined) {
    warnMalformedClaim(claimName, expected, describeClaimType(raw));
  }
}

function warnIfArrayDropped(claimName: string, raw: unknown, guarded: unknown[] | undefined, expected: string): void {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    warnMalformedClaim(claimName, expected, describeClaimType(raw));
    return;
  }
  if ((guarded ?? []).length !== raw.length) {
    warnMalformedClaim(claimName, expected, 'array with one or more malformed entries');
  }
}

/**
 * Extracts and shape-validates the `org` scope claims (`org_id`, `org_role`, `org_memberships`)
 * from a decoded JWT payload. A claim (or individual `org_memberships` entry) whose runtime shape
 * does not match its published type is omitted, never returned malformed.
 */
export function extractOrgClaims(rawClaims: Record<string, unknown>): OrgClaims {
  const org_id = guardOrgIdOrRole(rawClaims['org_id']);
  warnIfScalarDropped('org_id', rawClaims['org_id'], org_id, 'string or null');

  const org_role = guardOrgIdOrRole(rawClaims['org_role']);
  warnIfScalarDropped('org_role', rawClaims['org_role'], org_role, 'string or null');

  const org_memberships = guardOrgMemberships(rawClaims['org_memberships']);
  warnIfArrayDropped(
    'org_memberships',
    rawClaims['org_memberships'],
    org_memberships,
    'array of org membership objects',
  );

  return { org_id, org_role, org_memberships };
}
