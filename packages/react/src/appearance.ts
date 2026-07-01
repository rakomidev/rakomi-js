'use client';

/**
 * Appearance API — resolves className for pre-built component elements.
 * Local (component-level) REPLACES global (provider-level) — not concatenation.
 * Predictable behavior.
 */

import { createContext, useContext } from 'react';

export type AppearanceConfig = { elements?: Record<string, string> };

/** Global appearance context — set on <RakomiProvider appearance={...}> */
export const AppearanceContext = createContext<AppearanceConfig | undefined>(undefined);

/** Internal hook — reads global appearance from RakomiProvider context */
export function useGlobalAppearance(): AppearanceConfig | undefined {
  return useContext(AppearanceContext);
}

/**
 * Resolve className for a component element.
 * Priority: component appearance → global appearance → empty string.
 * Local replaces global (not concatenation).
 */
export function resolveClassName(
  element: string,
  componentAppearance?: AppearanceConfig,
  globalAppearance?: AppearanceConfig,
): string {
  if (componentAppearance?.elements && element in componentAppearance.elements) {
    return componentAppearance.elements[element] ?? '';
  }

  if (globalAppearance?.elements && element in globalAppearance.elements) {
    return globalAppearance.elements[element] ?? '';
  }

  return '';
}
