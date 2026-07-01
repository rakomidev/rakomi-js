'use client';

/**
 * Internal hook: reads locale from component props → provider context → 'en' fallback.
 * Returns a t() function for translating UI strings.
 */

import { useContext, useMemo } from 'react';

import { RakomiLocaleContext, RakomiTranslationsContext } from '../context.js';
import { createTranslator } from '../i18n/index.js';
import type { Locale, TranslationFn, Translations } from '../i18n/types.js';

/**
 * useTranslation — internal hook for pre-built components.
 * Cascade: componentLocale → providerLocale (from context) → 'en'.
 * Translation overrides merge in priority order:
 *   component-level `overrides` > Provider `translations` prop > locale dictionary > English.
 */
export function useTranslation(
  componentLocale?: Locale,
  _providerLocale?: Locale,
  overrides?: Partial<Translations>,
): TranslationFn {
  const providerLocale = useContext(RakomiLocaleContext);
  const providerTranslations = useContext(RakomiTranslationsContext);
  const locale = componentLocale ?? _providerLocale ?? providerLocale ?? 'en';

  const mergedOverrides = overrides
    ? { ...providerTranslations, ...overrides }
    : providerTranslations;
  const overridesKey = mergedOverrides ? JSON.stringify(mergedOverrides) : '';
  const stableOverrides = useMemo(() => mergedOverrides, [overridesKey]);

  return useMemo(
    () => createTranslator(locale, stableOverrides),
    [locale, stableOverrides],
  );
}
