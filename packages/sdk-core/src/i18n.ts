/**
 * Minimal i18n surface.
 *
 * `Locale` covers the full set of officially supported EU languages. It stays a LOCAL literal
 * union here, not a type import from an internal workspace package: a type import would leak an
 * internal package reference into every published `.d.ts`. A compile-time guard (in this
 * package's type tests) asserts this union stays identical to the platform's canonical locale
 * set, so a future widening that forgets this file fails typecheck rather than drifting silently.
 *
 * Ships the `Locale` and `Translations` types + the `createTranslator` factory + plural-rule
 * selection. This package ships its OWN minimal dictionaries — currently 5 (en/pl/de/fr/es) —
 * independent of how many locales are translated elsewhere in the platform. Widening `Locale`
 * therefore does NOT widen `DICTIONARIES`: it stays a partial map, and `createTranslator` falls
 * back to English and reports the gap once per locale via `console.warn`, keyed off this
 * package's OWN translated-locale set (`hasLocalTranslation`, below) — a locale can be
 * structurally valid without this package shipping a dictionary for it yet.
 */

import { isGaLocale } from './_inlined-symbols.js';

export type Locale =
  | 'en' | 'pl' | 'bg' | 'cs' | 'da' | 'de' | 'el' | 'es' | 'et' | 'fi' | 'fr' | 'ga'
  | 'hr' | 'hu' | 'it' | 'lt' | 'lv' | 'mt' | 'nl' | 'pt' | 'ro' | 'sk' | 'sl' | 'sv';

export type TranslationKey = string;

/** Translations dictionary — flat key/value map. Subkeys use dot-notation. */
export type Translations = Record<TranslationKey, string>;

export type TranslationFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * CLDR plural rule selection. Exact-form for the 5 locales this package ships a dictionary for;
 * every other locale (no dictionary yet, so its messages always render in English via the
 * fallback below) falls through to the 2-form `en` rule as a reasonable default — no shipped
 * string needs a locale-specific form for a locale that has no translated content anyway.
 * (Polish has 4 forms, others 2 — used by SignIn/SignUp resend countdowns etc.)
 */
export function selectPluralForm(locale: Locale, n: number): 'one' | 'few' | 'many' | 'other' {
  if (locale === 'pl') {
    if (n === 1) return 'one';
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }
  return n === 1 ? 'one' : 'other';
}

const FALLBACK: Translations = {
  'signin.title': 'Sign in',
  'signin.email': 'Email',
  'signin.password': 'Password',
  'signin.submit': 'Continue',
  'signin.mfa.title': 'Verify your identity',
  'signin.mfa.code': 'Authenticator code',
  'signin.mfa.submit': 'Verify',
  'signin.mfa.unavailable': 'Multi-factor authentication is not available for this account.',
  'signup.title': 'Create your account',
  'signup.email': 'Email',
  'signup.password': 'Password',
  'signup.submit': 'Create account',
  'common.cancel': 'Cancel',
  'common.continue': 'Continue',
  'common.error.network': 'Network error — try again',
  'common.error.unknown': 'Something went wrong',
  'biometric.prompt.unlock': 'Unlock to continue',
  'session.expiring': 'Your session is about to expire',
};

const PL: Translations = {
  'signin.title': 'Zaloguj się',
  'signin.email': 'E-mail',
  'signin.password': 'Hasło',
  'signin.submit': 'Kontynuuj',
  'signin.mfa.title': 'Potwierdź tożsamość',
  'signin.mfa.code': 'Kod uwierzytelniający',
  'signin.mfa.submit': 'Zweryfikuj',
  'signin.mfa.unavailable': 'Uwierzytelnianie wieloskładnikowe nie jest dostępne dla tego konta.',
  'signup.title': 'Utwórz konto',
  'signup.email': 'E-mail',
  'signup.password': 'Hasło',
  'signup.submit': 'Utwórz konto',
  'common.cancel': 'Anuluj',
  'common.continue': 'Kontynuuj',
  'common.error.network': 'Błąd sieci — spróbuj ponownie',
  'common.error.unknown': 'Coś poszło nie tak',
  'biometric.prompt.unlock': 'Odblokuj, aby kontynuować',
  'session.expiring': 'Twoja sesja wkrótce wygaśnie',
};

const DE: Translations = {
  'signin.title': 'Anmelden',
  'signin.email': 'E-Mail',
  'signin.password': 'Passwort',
  'signin.submit': 'Weiter',
  'signin.mfa.title': 'Identität bestätigen',
  'signin.mfa.code': 'Authenticator-Code',
  'signin.mfa.submit': 'Bestätigen',
  'signin.mfa.unavailable': 'Mehrstufige Authentifizierung ist für dieses Konto nicht verfügbar.',
  'signup.title': 'Konto erstellen',
  'signup.email': 'E-Mail',
  'signup.password': 'Passwort',
  'signup.submit': 'Konto erstellen',
  'common.cancel': 'Abbrechen',
  'common.continue': 'Weiter',
  'common.error.network': 'Netzwerkfehler — bitte erneut versuchen',
  'common.error.unknown': 'Es ist ein Fehler aufgetreten',
  'biometric.prompt.unlock': 'Zum Fortfahren entsperren',
  'session.expiring': 'Ihre Sitzung läuft bald ab',
};

const FR: Translations = {
  'signin.title': 'Se connecter',
  'signin.email': 'E-mail',
  'signin.password': 'Mot de passe',
  'signin.submit': 'Continuer',
  'signin.mfa.title': 'Vérifiez votre identité',
  'signin.mfa.code': 'Code authentificateur',
  'signin.mfa.submit': 'Vérifier',
  'signin.mfa.unavailable': "L'authentification multifacteur n'est pas disponible pour ce compte.",
  'signup.title': 'Créer un compte',
  'signup.email': 'E-mail',
  'signup.password': 'Mot de passe',
  'signup.submit': 'Créer le compte',
  'common.cancel': 'Annuler',
  'common.continue': 'Continuer',
  'common.error.network': 'Erreur réseau — réessayez',
  'common.error.unknown': "Une erreur s'est produite",
  'biometric.prompt.unlock': 'Déverrouillez pour continuer',
  'session.expiring': 'Votre session expire bientôt',
};

const ES: Translations = {
  'signin.title': 'Iniciar sesión',
  'signin.email': 'Correo electrónico',
  'signin.password': 'Contraseña',
  'signin.submit': 'Continuar',
  'signin.mfa.title': 'Verifica tu identidad',
  'signin.mfa.code': 'Código de autenticación',
  'signin.mfa.submit': 'Verificar',
  'signin.mfa.unavailable': 'La autenticación multifactor no está disponible para esta cuenta.',
  'signup.title': 'Crea tu cuenta',
  'signup.email': 'Correo electrónico',
  'signup.password': 'Contraseña',
  'signup.submit': 'Crear cuenta',
  'common.cancel': 'Cancelar',
  'common.continue': 'Continuar',
  'common.error.network': 'Error de red — vuelve a intentarlo',
  'common.error.unknown': 'Algo salió mal',
  'biometric.prompt.unlock': 'Desbloquea para continuar',
  'session.expiring': 'Tu sesión está a punto de expirar',
};

const DICTIONARIES: Partial<Record<Locale, Translations>> = {
  en: FALLBACK,
  pl: PL,
  de: DE,
  fr: FR,
  es: ES,
};

/** True when this package ships an actual (non-fallback) dictionary for `locale`. */
function hasLocalTranslation(locale: Locale): boolean {
  return Object.prototype.hasOwnProperty.call(DICTIONARIES, locale);
}

const warnedFallbackLocales = new Set<string>();

export function __resetLocaleFallbackWarningsForTest(): void {
  warnedFallbackLocales.clear();
}

/**
 * Build a translator function that consults `overrides` first, then the
 * locale dictionary (when shipped), then English fallback.
 *
 * A locale outside this package's 5 shipped dictionaries falls back to English and reports the
 * gap exactly once (never per call) via `console.warn` — the message distinguishes a
 * structurally-valid locale with no dictionary yet from a value that is not a recognized locale
 * at all. Full dictionaries for the remaining locales land incrementally; the contract is the
 * same shape either way.
 */
export function createTranslator(locale: Locale, overrides?: Partial<Translations>): TranslationFn {
  if (!hasLocalTranslation(locale) && !warnedFallbackLocales.has(locale)) {
    warnedFallbackLocales.add(locale);
    const reason = isGaLocale(locale)
      ? 'this is a supported locale, but this package has no dictionary for it yet'
      : 'this is not a locale this package supports';
    console.warn(`[@rakomi/sdk-core] no translations for locale "${locale}" — falling back to English (${reason}).`);
  }
  const dict = DICTIONARIES[locale] ?? FALLBACK;
  return (key, params) => {
    const raw = overrides?.[key] ?? dict[key] ?? FALLBACK[key] ?? key;
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const v = params[name];
      return v == null ? `{${name}}` : String(v);
    });
  };
}
