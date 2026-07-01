/**
 * Conditional render components — RN ports of `@rakomi/react`'s
 * `<SignedIn>`, `<SignedOut>`, `<Protect>`, `<Feature>`. Identical contracts
 * (parity test asserts).
 *
 * They render a `Fragment` (no DOM/RN primitive nesting) — pure logic gates.
 */

'use client';

import type { ReactNode } from 'react';

import type { HasParams } from '@rakomi/sdk-core';
import { hasPermission, hasRole } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

export interface SignedInProps {
  children: ReactNode;
}

export function SignedIn({ children }: SignedInProps): ReactNode {
  const { isSignedIn } = useRakomiContext();
  return isSignedIn ? <>{children}</> : null;
}

export interface SignedOutProps {
  children: ReactNode;
}

export function SignedOut({ children }: SignedOutProps): ReactNode {
  const { isSignedIn } = useRakomiContext();
  return isSignedIn ? null : <>{children}</>;
}

export interface ProtectProps extends HasParams {
  children: ReactNode;
  /** Rendered when the predicate fails. Default: nothing. */
  fallback?: ReactNode;
}

export function Protect({ children, fallback = null, permission, role }: ProtectProps): ReactNode {
  const { user, isSignedIn } = useRakomiContext();
  if (!isSignedIn || !user) return <>{fallback}</>;
  if (permission && !hasPermission(user, permission)) return <>{fallback}</>;
  if (role && !hasRole(user, role)) return <>{fallback}</>;
  return <>{children}</>;
}

/**
 * `<Feature flag="…">` — render only when a feature flag is enabled. v0.1.0 stub:
 * checks `user.rawClaims.feature_flags?.[flag] === true`. Full wiring
 * (`useFlag` with provider + targeting rules) lands later — surface stays stable.
 */
export interface FeatureProps {
  flag: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export function Feature({ flag, children, fallback = null }: FeatureProps): ReactNode {
  const { user } = useRakomiContext();
  const flags = (user?.rawClaims['feature_flags'] as Record<string, unknown> | undefined) ?? {};
  return flags[flag] === true ? <>{children}</> : <>{fallback}</>;
}
