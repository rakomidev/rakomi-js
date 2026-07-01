'use client';

/**
 * <SignedOut> — conditional rendering component.
 *
 * Renders children when the user is NOT authenticated (isLoaded: true, isSignedIn: false).
 * Renders fallback while loading (isLoaded: false).
 * Renders nothing (null) when signed in and no fallback is provided.
 *
 * CLS mitigation: provide a `fallback` prop with a skeleton of fixed dimensions
 * to prevent layout shift during the auth state loading phase.
 *
 * @example
 * <SignedOut fallback={<LoginSkeleton />}>
 *   <LoginForm />
 * </SignedOut>
 */

import React from 'react';

import { useRakomiContext } from '../context.js';

export interface SignedOutProps {
  children: React.ReactNode;
  /** Rendered while auth state is loading (isLoaded: false). Prevents CLS. */
  fallback?: React.ReactNode;
}

export function SignedOut({ children, fallback = null }: SignedOutProps): React.ReactElement | null {
  const auth = useRakomiContext();

  if (!auth.isLoaded) {
    return fallback as React.ReactElement | null;
  }

  if (auth.isSignedIn) {
    return null;
  }

  return <>{children}</>;
}
