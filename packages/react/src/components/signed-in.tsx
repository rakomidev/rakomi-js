'use client';

/**
 * <SignedIn> — conditional rendering component.
 *
 * Renders children when the user is authenticated (isLoaded: true, isSignedIn: true).
 * Renders fallback while loading (isLoaded: false).
 * Renders nothing (null) when signed out and no fallback is provided.
 *
 * CLS mitigation: provide a `fallback` prop with a skeleton of fixed dimensions
 * to prevent layout shift during the auth state loading phase.
 *
 * @example
 * <SignedIn fallback={<DashboardSkeleton />}>
 *   <Dashboard />
 * </SignedIn>
 *
 * LCP guidance: place auth-independent LCP elements (hero images, headings) OUTSIDE
 * conditional components. Auth-gated content delays LCP by 120-540ms (network RTT
 * for silent refresh on first load).
 */

import React from 'react';

import { useRakomiContext } from '../context.js';

export interface SignedInProps {
  children: React.ReactNode;
  /** Rendered while auth state is loading (isLoaded: false). Prevents CLS. */
  fallback?: React.ReactNode;
}

export function SignedIn({ children, fallback = null }: SignedInProps): React.ReactElement | null {
  const auth = useRakomiContext();

  if (!auth.isLoaded) {
    return fallback as React.ReactElement | null;
  }

  if (!auth.isSignedIn) {
    return null;
  }

  return <>{children}</>;
}
