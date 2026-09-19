
export const RAKOMI_PLATFORM_ISSUER = 'https://api.rakomi.com';

export const GA_LOCALES = [
  'en',
  'pl',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'ga',
  'hr',
  'hu',
  'it',
  'lt',
  'lv',
  'mt',
  'nl',
  'pt',
  'ro',
  'sk',
  'sl',
  'sv',
] as const;

export type GaLocale = (typeof GA_LOCALES)[number];

export function isGaLocale(value: unknown): value is GaLocale {
  return typeof value === 'string' && (GA_LOCALES as readonly string[]).includes(value);
}
