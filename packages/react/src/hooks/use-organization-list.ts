'use client';

import { extractOrgClaims } from '@rakomi/sdk-core';

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

  const { org_memberships: organizations } = extractOrgClaims(state.user.rawClaims);

  return { isLoaded: true, organizations: organizations ?? [] };
}
