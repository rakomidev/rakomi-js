'use client';

import type { UserResource } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

export interface UseUserReturn {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: UserResource | null;
}

export function useUser(): UseUserReturn {
  const { snapshot } = useRakomiContext();
  return {
    isLoaded: snapshot.state !== 'authenticating',
    isSignedIn: snapshot.state === 'authenticated' || snapshot.state === 'refreshing' || snapshot.state === 'offline_stale',
    user: snapshot.user,
  };
}
