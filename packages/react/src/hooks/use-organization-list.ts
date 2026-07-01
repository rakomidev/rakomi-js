'use client';

import { useRakomiContext } from '../context.js';
import type { OrgMembership } from '../types.js';

export interface UseOrganizationListReturn {
  isLoaded: boolean;
  organizations: OrgMembership[];
}

/**
 * Returns all organization memberships from the JWT `org_memberships` claim.
 * Returns an empty array when not signed in or when the user has no org memberships.
 */
export function useOrganizationList(): UseOrganizationListReturn {
  const state = useRakomiContext();

  if (!state.isLoaded) {
    return { isLoaded: false, organizations: [] };
  }

  if (!state.isSignedIn) {
    return { isLoaded: true, organizations: [] };
  }

  const rawClaims = state.user.rawClaims;
  const rawMemberships = Array.isArray(rawClaims['org_memberships']) ? rawClaims['org_memberships'] : [];

  const organizations = rawMemberships.filter(
    (m): m is OrgMembership =>
      m != null &&
      typeof m === 'object' &&
      typeof (m as Record<string, unknown>)['org_id'] === 'string' &&
      typeof (m as Record<string, unknown>)['org_slug'] === 'string' &&
      typeof (m as Record<string, unknown>)['org_role'] === 'string',
  );

  return { isLoaded: true, organizations };
}
