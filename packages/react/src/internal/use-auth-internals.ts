'use client';

/**
 * Internal hook — provides baseUrl, clientId, redirectUrl, and completeSignIn to pre-built components.
 * NOT part of public API.
 */

import { useContext, useSyncExternalStore } from 'react';

import type { RakomiInternals } from '../context.js';
import { RakomiColorSchemeContext, RakomiInternalsContext } from '../context.js';
import {
  getColorSchemeServerSnapshot,
  getColorSchemeSnapshot,
  subscribeToColorScheme,
} from './branding-styles.js';

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

/**
 * The end user's own colour-scheme preference, SUBSCRIBED rather than sampled.
 *
 * A one-shot read would leave a mid-session theme flip unpainted: the value would change and no
 * component would re-render. The server snapshot is stable so hydration reconciles instead of
 * mismatching.
 */
export function usePrefersDarkScheme(): boolean {
  return useSyncExternalStore(subscribeToColorScheme, getColorSchemeSnapshot, getColorSchemeServerSnapshot);
}
