/**
 * i18n module for @rakomi/react pre-built components.
 * createTranslator() returns a t(key, params?) function.
 * Supports simple {param} interpolation and locale-aware ICU-style pluralization.
 *
 * Supported locales grew to the full EU set (`Locale` is now a wider union — see `./types.js`), and
 * — as of `i18n-eu-ui-batch-c` (the third and final translation batch) — `GA_LOCALES_TRANSLATED` now
 * covers all 24 of them: `en`/`pl`/`de`/`fr`/`es`/`it`/`nl`/`pt`/`ro`/`cs`/`hu`/`el`/`sv`/`bg`/`da`/
 * `fi`/`sk`/`sl`/`hr`/`lt`/`lv`/`et`/`mt`/`ga`. `createTranslator` still falls back to English and
 * reports the gap via `console.warn` once (never per-call) for a locale outside `Locale`'s type
 * entirely (a non-GA string, e.g. a typo or an as-yet-unofficial code) — that branch is now
 * unreachable for any value TypeScript accepts as a `Locale`, but is kept as the fail-safe for a
 * caller bypassing the type (a `.js` consumer, or an explicit cast).
 */

import { hasGaLocaleTranslation, interpolate, isGaLocale } from '../_inlined-symbols.js';

import { bg } from './bg.js';
import { cs } from './cs.js';
import { da } from './da.js';
import { de } from './de.js';
import { el } from './el.js';
import { en } from './en.js';
import { es } from './es.js';
import { et } from './et.js';
import { fi } from './fi.js';
import { fr } from './fr.js';
import { ga } from './ga.js';
import { hr } from './hr.js';
import { hu } from './hu.js';
import { it } from './it.js';
import { lt } from './lt.js';
import { lv } from './lv.js';
import { mt } from './mt.js';
import { nl } from './nl.js';
import { pl } from './pl.js';
import { pt } from './pt.js';
import { ro } from './ro.js';
import { sk } from './sk.js';
import { sl } from './sl.js';
import { sv } from './sv.js';
import type { Locale, TranslationFn, TranslationKey, Translations } from './types.js';

export type { Locale, TranslationFn, TranslationKey, Translations };
export { bg, cs, da, de, el, en, es, et, fi, fr, ga, hr, hu, it, lt, lv, mt, nl, pl, pt, ro, sk, sl, sv };

const locales: Partial<Record<Locale, Translations>> = {
  en, pl, de, fr, es, it, nl, pt, ro, cs, hu, el, sv, bg, da, fi, sk, sl, hr, lt, lv, et, mt, ga,
};

const warnedFallbackLocales = new Set<string>();

export function __resetLocaleFallbackWarningsForTest(): void {
  warnedFallbackLocales.clear();
}

/** CLDR plural categories used in this codebase. 'few'/'many' are Polish-only. */
type PluralForm = 'one' | 'few' | 'many' | 'other';

/**
 * Locale-aware plural selector. Returns the CLDR plural category for (locale, count).
 * Hand-rolled (no full CLDR dep) — covers the translated locales exactly:
 *   en, de, es, it, nl, pt, hu, el, sv, bg, da, fi — 2 forms: count === 1 → 'one', else 'other'
 *     (this IS their real CLDR rule for every one of these, not an approximation).
 *   fr        — 2 forms, CLDR: count === 0 || count === 1 → 'one', else 'other'.
 *   pl        — 4 forms: one / few (2–4 excl. 12–14) / many (0, 5+, 12–14) / other.
 *   ro        — 3 forms, CLDR: one (n===1) / few (n===0, or 1–19 of a hundred, i.e.
 *               n%100 is 1–19 for any n!==1) / other.
 *   cs        — 4 forms, CLDR (integers only, this codebase has no fractional counts): one
 *               (n===1) / few (n is 2–4) / many (unused for integers — v!==0 never holds here) /
 *               other. `few` therefore covers exactly {2,3,4}; every other integer is 'other'.
 * Every OTHER supported locale (sk, sl, hr, lt, lv, et, mt, ga — whose real CLDR rules range from
 * 2-form to 4-form, several with fractional-count categories this codebase never produces) falls
 * through to the 2-form rule as a reasonable default: no shipped string uses the 4-form
 * `{count, plural, one {} few {} many {} other {}}` syntax today, so a locale-specific branch for
 * any of them is currently inert regardless of how precisely it would match its real CLDR rule.
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

  if (locale === 'ro') {
    const mod100 = abs % 100;
    if (abs === 1) return 'one';
    if (abs === 0 || (mod100 >= 1 && mod100 <= 19)) return 'few';
    return 'other';
  }

  if (locale === 'cs') {
    if (abs === 1) return 'one';
    if (abs >= 2 && abs <= 4) return 'few';
    return 'other';
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
  if (!hasGaLocaleTranslation(locale) && !warnedFallbackLocales.has(locale)) {
    warnedFallbackLocales.add(locale);
    const reason = isGaLocale(locale)
      ? 'this is a supported locale, but its translations have not shipped yet — more ship incrementally'
      : 'this is not a locale @rakomi/react supports';
    console.warn(`[@rakomi/react] no translations for locale "${locale}" — falling back to English (${reason}).`);
  }
  const translations = locales[locale] ?? en;

  return (key: TranslationKey, params?: Record<string, string | number>): string => {
    const template = overrides?.[key] ?? translations[key] ?? en[key] ?? key;
    if (!params) return template;
    const afterPlural = resolvePlural(template, locale, params);
    return interpolate(afterPlural, params);
  };
}
