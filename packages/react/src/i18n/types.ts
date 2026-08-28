/**
 * i18n types for @rakomi/react pre-built components.
 * All translatable string keys organized by component.
 */

/**
 * The set of locales this SDK can route/negotiate for — the 24 official EU languages. A member without
 * a translated dictionary falls back to English in `createTranslator` (see `index.ts`).
 *
 * A LOCAL mirror of the platform's locale set, deliberately not a type import: a type imported from an
 * internal workspace package rides into the published `.d.ts` as an internal package reference (this
 * package's dist scan rejects that). `test/type-mirror-drift.test-d.ts` asserts this union stays
 * identical to the platform source of truth at typecheck time.
 */
export type Locale =
  | 'en' | 'pl' | 'bg' | 'cs' | 'da' | 'de' | 'el' | 'es' | 'et' | 'fi' | 'fr' | 'ga'
  | 'hr' | 'hu' | 'it' | 'lt' | 'lv' | 'mt' | 'nl' | 'pt' | 'ro' | 'sk' | 'sl' | 'sv';

/** All translation keys — organized by component namespace. */
export interface Translations {
  'signIn.title': string;
  'signIn.titleBranded': string;
  'signIn.emailLabel': string;
  'signIn.passwordLabel': string;
  'signIn.submitButton': string;
  'signIn.forgotPassword': string;
  'signIn.noAccount': string;
  'signIn.or': string;
  'signIn.otherOptions': string;
  'signIn.socialGroup': string;
  'signIn.socialButton': string;
  'signIn.rememberMe': string;
  'signIn.slowConnection': string;
  'signIn.redirecting': string;
  'signIn.configError': string;
  'signIn.emailRequired': string;
  'signIn.interstitial.countdown': string;
  'signIn.interstitial.cancel': string;

  'signIn.mfa.title': string;
  'signIn.mfa.codeLabel': string;
  'signIn.mfa.tooManyAttempts': string;
  'signIn.mfa.recoveryCode': string;
  'signIn.mfa.expired': string;
  'signIn.mfa.back': string;

  'signIn.magicLink.send': string;
  'signIn.magicLink.sent': string;
  'signIn.magicLink.checkSpam': string;
  'signIn.magicLink.takingAMoment': string;
  'signIn.magicLink.resend': string;

  'signIn.emailOtp.send': string;
  'signIn.emailOtp.sent': string;
  'signIn.emailOtp.codeLabel': string;

  'signIn.forgotPasswordInline.title': string;
  'signIn.forgotPasswordInline.submit': string;
  'signIn.forgotPasswordInline.success': string;

  'signIn.resetPassword.title': string;
  'signIn.resetPassword.submit': string;
  'signIn.resetPassword.success': string;

  'signUp.title': string;
  'signUp.titleBranded': string;
  'signUp.consentLabel': string;
  'signUp.consentLink': string;
  'signUp.verifyTitle': string;
  'signUp.verifyMessage': string;
  'signUp.verifyCheckSpam': string;
  'signUp.resend': string;
  'signUp.hasAccount': string;
  'signUp.dataLocation': string;
  'signUp.existingAccountHint': string;
  'signUp.passwordMismatch': string;
  'signUp.passwordTooShort': string;
  'signUp.consentRequired': string;
  'signUp.termsOfService': string;
  'signUp.privacyPolicy': string;
  'signUp.emailInvalid': string;
  'signUp.passwordStrength.weak': string;
  'signUp.passwordStrength.fair': string;
  'signUp.passwordStrength.strong': string;
  'signUp.passwordStrength.veryStrong': string;

  'userButton.signOut': string;
  'userButton.manage': string;

  'userProfile.title': string;
  'userProfile.passwordSection': string;
  'userProfile.mfaSection': string;
  'userProfile.mfaSetup': string;
  'userProfile.mfaManualEntry': string;
  'userProfile.mfaDisable': string;
  'userProfile.mfaRecoveryCodes': string;
  'userProfile.mfaRecoveryWarning': string;
  'userProfile.mfaRecoveryPrint': string;
  'userProfile.sessionsSection': string;
  'userProfile.sessionCurrent': string;
  'userProfile.sessionRevoke': string;
  'userProfile.sessionRevokeAll': string;
  'userProfile.sessionRevokePartial': string;
  'userProfile.sessionExpired': string;
  'userProfile.noOtherSessions': string;
  'userProfile.currentPassword': string;
  'userProfile.newPassword': string;
  'userProfile.confirmPassword': string;
  'userProfile.passwordChanged': string;

  'common.loading': string;
  'common.error': string;
  'common.retry': string;
  'common.cancel': string;
  'common.save': string;
  'common.copy': string;
  'common.back': string;
  'common.showPassword': string;
  'common.hidePassword': string;
  'common.somethingWentWrong': string;
  'common.tenantSuspended': string;
  'common.permanentError': string;
  'common.reload': string;
  'common.rateLimited': string;

  'error.invalidCredentials': string;
  'error.emailNotVerified': string;
  'error.accountLocked': string;
  'error.networkError': string;
  'error.unknownError': string;
}

export type TranslationKey = keyof Translations;

/** Translation function returned by createTranslator. */
export type TranslationFn = (key: TranslationKey, params?: Record<string, string | number>) => string;
