'use client';

import { useRakomiContext } from '../context.js';
import type { OrgContext, OrgMembership } from '../types.js';

export interface UseOrganizationReturn {
  isLoaded: boolean;
  org: OrgContext | null;
}

/**
 * Returns the current active organization context from the JWT.
 * `org` is null when not signed in, or when no org context is active (personal mode).
 */
export function useOrganization(): UseOrganizationReturn {
  const state = useRakomiContext();

  if (!state.isLoaded) {
    return { isLoaded: false, org: null };
  }

  if (!state.isSignedIn) {
    return { isLoaded: true, org: null };
  }

  const rawClaims = state.user.rawClaims;
  const orgId = typeof rawClaims['org_id'] === 'string' ? rawClaims['org_id'] : null;
  const orgRole = typeof rawClaims['org_role'] === 'string' ? rawClaims['org_role'] : null;

  if (!orgId || !orgRole) {
    return { isLoaded: true, org: null };
  }

  const rawMemberships = Array.isArray(rawClaims['org_memberships']) ? rawClaims['org_memberships'] : [];
  const orgMemberships = rawMemberships.filter(
    (m): m is OrgMembership =>
      m != null &&
      typeof m === 'object' &&
      typeof (m as Record<string, unknown>)['org_id'] === 'string' &&
      typeof (m as Record<string, unknown>)['org_slug'] === 'string' &&
      typeof (m as Record<string, unknown>)['org_role'] === 'string',
  );

  return { isLoaded: true, org: { orgId, orgRole, orgMemberships } };
}
