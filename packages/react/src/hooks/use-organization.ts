'use client';

import { extractOrgClaims } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';
import type { OrgContext } from '../types.js';

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

  const { org_id: orgId, org_role: orgRole, org_memberships: orgMemberships } = extractOrgClaims(
    state.user.rawClaims,
  );

  if (!orgId || !orgRole) {
    return { isLoaded: true, org: null };
  }

  return { isLoaded: true, org: { orgId, orgRole, orgMemberships: orgMemberships ?? [] } };
}
