'use client';

import type { SessionResource } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

export interface UseSessionReturn {
  isLoaded: boolean;
  isSignedIn: boolean;
  session: SessionResource | null;
}

export function useSession(): UseSessionReturn {
  const { snapshot } = useRakomiContext();
  return {
    isLoaded: snapshot.state !== 'authenticating',
    isSignedIn: snapshot.state === 'authenticated' || snapshot.state === 'refreshing' || snapshot.state === 'offline_stale',
    session: snapshot.session,
  };
}
