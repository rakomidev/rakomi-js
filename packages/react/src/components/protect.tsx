'use client';

/**
 * <Protect> — declarative authorization guard component.
 *
 * Renders children only when the signed-in user passes the specified authorization check.
 * Uses useAuth.has internally — wildcard-aware permission matching.
 *
 * CRITICAL: <Protect> is a UI-only guard. It hides UI elements but does NOT enforce
 * authorization on the server. Every route protected by <Protect> in the frontend
 * MUST ALSO be protected by requirePermission/requireRole on the backend.
 * <Protect> is a UX convenience, NOT a security control (NIST SP 800-207).
 *
 * CRITICAL: Renders <>{children}</> (Fragment) — NEVER wraps in <div> or any HTML element.
 * This ensures React Native compatibility.
 *
 * @example
 * <Protect permission="posts:write" fallback={<Forbidden />}>
 * <EditButton />
 * </Protect>
 *
 * <Protect role="admin">
 * <AdminPanel />
 * </Protect>
 */

import React from 'react';

import { useRakomiContext } from '../context.js';

export interface ProtectProps {
  permission?: string;
  role?: string;
  /** Rendered when authorization check fails or user is signed out. Default: null. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function Protect({ permission, role, fallback = null, children }: ProtectProps): React.ReactElement | null {
  const auth = useRakomiContext();

  if (!auth.isLoaded || !auth.isSignedIn) {
    return fallback as React.ReactElement | null;
  }

  try {
    const params: Record<string, string> = {};
    if (permission) params['permission'] = permission;
    if (role) params['role'] = role;

    if (!auth.has(params)) {
      return fallback as React.ReactElement | null;
    }
  } catch {
    return fallback as React.ReactElement | null;
  }

  return <>{children}</>;
}
