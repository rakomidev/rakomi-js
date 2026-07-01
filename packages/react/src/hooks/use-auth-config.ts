'use client';

/**
 * useAuthConfig — public hook for tenant auth config discovery.
 * Returns { config, isLoading, error }.
 * Uses cached result from AuthConfigManager (lazy initialization).
 * Enables developers building custom UI to discover tenant auth configuration.
 */

import { useContext, useEffect, useSyncExternalStore } from 'react';

import { AuthConfigManagerContext } from '../context.js';
import type { AuthConfig, AuthError } from '../types.js';

export interface UseAuthConfigReturn {
  config: AuthConfig | null;
  isLoading: boolean;
  error: AuthError | null;
}

const noopSubscribe = () => () => {};
const noopSnapshot = () => ({ status: 'idle' as const });

export function useAuthConfig(): UseAuthConfigReturn {
  const manager = useContext(AuthConfigManagerContext);

  const state = useSyncExternalStore(
    manager?.subscribe ?? noopSubscribe,
    manager?.getSnapshot ?? noopSnapshot,
    manager?.getServerSnapshot ?? noopSnapshot,
  );

  useEffect(() => {
    if (manager) void manager.fetch();
  }, [manager]);

  if (!manager) {
    return { config: null, isLoading: false, error: { code: 'INVALID_CONFIG' as const, message: 'useAuthConfig must be used inside <RakomiProvider>' } };
  }

  switch (state.status) {
    case 'idle':
    case 'loading':
      return { config: null, isLoading: true, error: null };
    case 'loaded':
      return { config: state.config, isLoading: false, error: null };
    case 'error':
      return { config: null, isLoading: false, error: state.error };
  }
}
