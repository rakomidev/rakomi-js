'use client';

import React from 'react';

import { useFlag } from '../hooks/use-flag.js';

export interface FeatureProps {
  flag: string;
  value?: string | number | boolean;
  fallback?: React.ReactNode;
  loadingFallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Conditionally renders children based on feature flag value.
 *
 * - `<Feature flag="key">` renders children when flag is `=== true` or non-null/non-false non-boolean
 * - `<Feature flag="key" value="premium">` renders children when flag value exactly equals `"premium"`
 * - `<Feature flag="key" fallback={<Old />}>` renders fallback when flag is falsy or not found
 */
export function Feature({ flag, value: matchValue, fallback = null, loadingFallback = null, children }: FeatureProps): React.ReactElement | null {
  const { value: flagValue, isLoading } = useFlag(flag);

  if (isLoading) {
    return <>{loadingFallback}</>;
  }

  let shouldRender: boolean;

  if (matchValue !== undefined) {
    shouldRender = flagValue === matchValue;
  } else {
    shouldRender =
      flagValue === true ||
      (flagValue !== false && flagValue !== null && flagValue !== undefined);
  }

  return <>{shouldRender ? children : fallback}</>;
}
