'use client';

/**
 * useBranding — public hook for tenant branding configuration.
 * Returns { branding, isLoading } derived from useAuthConfig.
 * Branding is null when: config not loaded, no branding set, or Free tier.
 *
 * Merges API-fetched branding with provider `branding` prop override.
 * Prop values win per-field. When prop has colors, isLoading=false (no flash).
 */

import { useContext, useRef } from 'react';

import { RakomiInternalsContext } from '../context.js';
import type { BrandingConfig } from '../types.js';
import { useAuthConfig } from './use-auth-config.js';

export interface UseBrandingReturn {
  branding: BrandingConfig | null;
  isLoading: boolean;
}

function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '' && v !== null));
}

export function useBranding(): UseBrandingReturn {
  const { config, isLoading } = useAuthConfig();
  const internals = useContext(RakomiInternalsContext);
  const override = internals?.brandingOverride;

  const apiBranding = config?.branding ?? null;

  const branding = override
    ? { ...(apiBranding ?? { tenantName: '' }), ...stripEmpty(override) } as BrandingConfig
    : apiBranding;

  const hasOverrideColors = override && (override.primaryColor || override.backgroundColor);

  const warnedRef = useRef(false);
  if (!warnedRef.current && typeof globalThis !== 'undefined' && (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['NODE_ENV'] !== 'production' && override && apiBranding) {
    const stripped = stripEmpty(override);
    const apiRecord = apiBranding as unknown as Record<string, unknown>;
    const overriddenFields = Object.keys(stripped).filter(k => k in apiRecord && apiRecord[k] !== stripped[k]);
    if (overriddenFields.length > 0) {
      warnedRef.current = true;
      console.warn(`[Rakomi] branding prop is overriding API-fetched branding for fields: ${overriddenFields.join(', ')}. This is expected if intentional.`);
    }
  }

  return {
    branding,
    isLoading: hasOverrideColors ? false : isLoading,
  };
}
