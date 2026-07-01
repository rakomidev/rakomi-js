/**
 * i18n module for @rakomi/react pre-built components.
 * createTranslator() returns a t(key, params?) function.
 * Supports simple {param} interpolation and locale-aware ICU-style pluralization.
 */

import { interpolate } from '../_inlined-symbols.js';

import { de } from './de.js';
import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { pl } from './pl.js';
import type { Locale, TranslationFn, TranslationKey, Translations } from './types.js';

export type { Locale, TranslationFn, TranslationKey, Translations };
export { de, en, es,fr, pl };

const locales: Record<Locale, Translations> = { en, pl, de, fr, es };

/** CLDR plural categories used in this codebase. 'few'/'many' are Polish-only. */
type PluralForm = 'one' | 'few' | 'many' | 'other';

/**
 * Locale-aware plural selector. Returns the CLDR plural category for (locale, count).
 * Hand-rolled (no full CLDR dep) — covers the 5 GA locales:
 *   en, de, es — 2 forms: count === 1 → 'one', else 'other'.
 *   fr        — 2 forms, CLDR: count === 0 || count === 1 → 'one', else 'other'.
 *   pl        — 4 forms: one / few (2–4 excl. 12–14) / many (0, 5+, 12–14) / other.
 */
export function selectPluralForm(locale: Locale, count: number): PluralForm {
  if (!Number.isFinite(count)) return 'other';
  const abs = Math.abs(count);

  if (locale === 'pl') {
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (abs === 1) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'few';
    if (mod10 === 0 || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 12 && mod100 <= 14)) return 'many';
    return 'other';
  }

  if (locale === 'fr') {
    return abs === 0 || abs === 1 ? 'one' : 'other';
  }

  return abs === 1 ? 'one' : 'other';
}

/**
 * Resolve ICU-style plural patterns:
 *   {count, plural, one {# sesja} few {# sesje} many {# sesji} other {# sesji}}
 * - 4-form patterns (with `few`/`many`) are fully supported for Polish.
 * - 2-form patterns `{count, plural, one {...} other {...}}` are supported for every locale.
 * Unrecognized forms fall through to `other`.
 */
function resolvePlural(
  template: string,
  locale: Locale,
  params: Record<string, string | number>,
): string {
  const tpl4 = template.replace(
    /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*few\s*\{([^}]*)\}\s*many\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
    (_m, key: string, one: string, few: string, many: string, other: string) => {
      const count = typeof params[key] === 'number' ? params[key] : parseInt(String(params[key]), 10);
      if (isNaN(count)) return other.replaceAll('#', String(params[key] ?? ''));
      const form = selectPluralForm(locale, count);
      const picked = form === 'one' ? one : form === 'few' ? few : form === 'many' ? many : other;
      return picked.replaceAll('#', String(count));
    },
  );

  return tpl4.replace(
    /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
    (_m, key: string, one: string, other: string) => {
      const count = typeof params[key] === 'number' ? params[key] : parseInt(String(params[key]), 10);
      if (isNaN(count)) return other.replaceAll('#', String(params[key] ?? ''));
      const form = selectPluralForm(locale, count);
      const picked = form === 'one' ? one : other;
      return picked.replaceAll('#', String(count));
    },
  );
}

/**
 * Create a translator function for a given locale.
 * Overrides allow partial i18n customization without forking full translation.
 * Priority: overrides → locale translations → English fallback.
 */
export function createTranslator(
  locale: Locale = 'en',
  overrides?: Partial<Translations>,
): TranslationFn {
  const translations = locales[locale] ?? en;

  return (key: TranslationKey, params?: Record<string, string | number>): string => {
    const template = overrides?.[key] ?? translations[key] ?? en[key] ?? key;
    if (!params) return template;
    const afterPlural = resolvePlural(template, locale, params);
    return interpolate(afterPlural, params);
  };
}
