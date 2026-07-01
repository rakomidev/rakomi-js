'use client';

/**
 * Internal hook — provides baseUrl, clientId, redirectUrl, and completeSignIn to pre-built components.
 * NOT part of public API.
 */

import { useContext } from 'react';

import type { RakomiInternals } from '../context.js';
import { RakomiColorSchemeContext, RakomiInternalsContext } from '../context.js';

export function useRakomiInternals(): RakomiInternals {
  const ctx = useContext(RakomiInternalsContext);
  if (!ctx) {
    throw new Error(
      '[Rakomi] Pre-built components must be rendered inside <RakomiProvider>. ' +
      'See https://docs.rakomi.dev/react/setup',
    );
  }
  return ctx;
}

/** Read colorScheme from RakomiProvider context */
export function useColorScheme(): 'light' | 'dark' | 'auto' | undefined {
  return useContext(RakomiColorSchemeContext);
}
