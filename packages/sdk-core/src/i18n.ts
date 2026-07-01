/**
 * Minimal i18n surface.
 *
 * Supports 5 locales (en/pl/de/fr/es). Ships the `Locale` and `Translations` types
 * + the `createTranslator` factory + plural-rule selection; full dictionaries are
 * supplied by the components that consume them.
 */

export type Locale = 'en' | 'pl' | 'de' | 'fr' | 'es';

export type TranslationKey = string;

/** Translations dictionary — flat key/value map. Subkeys use dot-notation. */
export type Translations = Record<TranslationKey, string>;

export type TranslationFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * CLDR plural rule selection. Currently exact-form for the 5 GA locales.
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

const DICTIONARIES: Record<Locale, Translations> = {
  en: FALLBACK,
  pl: PL,
  de: DE,
  fr: FR,
  es: ES,
};

/**
 * Build a translator function that consults `overrides` first, then the
 * locale dictionary (when shipped), then English fallback.
 *
 * For 0.1.0 the locale dictionaries are pass-through to fallback unless
 * the consumer supplies `overrides` — keeps bundle small. Full dictionaries
 * land in a future release and the contract is the same shape.
 */
export function createTranslator(locale: Locale, overrides?: Partial<Translations>): TranslationFn {
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
