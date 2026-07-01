import type { Translations } from '../../i18n/types.js';

export type SignInStep =
  | 'idle'
  | 'email_password'
  | 'magic_link_sent'
  | 'email_otp_sent'
  | 'social_redirect'
  | 'social_interstitial'
  | 'forgot_password'
  | 'reset_password'
  | 'mfa_required'
  | 'complete'
  | 'error';

export interface SignInState {
  step: SignInStep;
  email: string;
  activeMethod: string | null;
  challengeToken: string;
  mfaExpiresIn: number;
  mfaAttempts: number;
  mfaUseRecovery: boolean;
  error: string | null;
  loading: boolean;
  resendAfterSeconds: number;
  /** Incremented each time a resend fires — forces useEffect to restart even when resendAfterSeconds is unchanged */
  resendSeq: number;
  otpExpiresAt: string;
  socialProvider: string;
  forgotPasswordSuccess: boolean;
  resetPasswordSuccess: boolean;
}

export type SignInAction =
  | { type: 'SET_STEP'; step: SignInStep }
  | { type: 'SET_EMAIL'; email: string }
  | { type: 'SET_ACTIVE_METHOD'; activeMethod: string }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_MFA'; challengeToken: string; expiresIn: number }
  | { type: 'INCREMENT_MFA_ATTEMPTS' }
  | { type: 'RESET_MFA_ATTEMPTS' }
  | { type: 'TOGGLE_MFA_RECOVERY' }
  | { type: 'SET_MAGIC_LINK_SENT'; resendAfterSeconds: number }
  | { type: 'RESEND_SENT'; resendAfterSeconds: number }
  | { type: 'SET_OTP_SENT'; resendAfterSeconds: number; expiresAt: string }
  | { type: 'SET_SOCIAL_REDIRECT'; provider: string }
  | { type: 'SET_FORGOT_PASSWORD_SUCCESS' }
  | { type: 'SET_RESET_PASSWORD_SUCCESS' }
  | { type: 'RESET' };

export interface SignInElements {
  root: string;
  form: string;
  title: string;
  field: string;
  label: string;
  input: string;
  passwordToggle: string;
  submitButton: string;
  socialButton: string;
  socialGrid: string;
  errorMessage: string;
  methodSwitcher: string;
  mfaStep: string;
  link: string;
  forgotPasswordInline: string;
  rememberMe: string;
  progressHint: string;
}

export interface SignInProps {
  title?: string | React.ReactNode;
  logo?: { src: string; alt: string };
  fallback?: React.ReactNode;
  initialValues?: { email?: string };
  methods?: string[];
  socialProviders?: string[];
  socialPosition?: 'top' | 'bottom';
  locale?: 'en' | 'pl';
  signUpUrl?: string;
  forgotPasswordUrl?: string;
  showRememberMe?: boolean;
  redirectIfAuthenticated?: string;
  /** Method to pre-select on mount. Changes after mount are ignored (mount-time hint, like defaultValue). */
  initialMethod?: string;
  afterSignInUrl?: string;
  onSignIn?: () => void;
  className?: string;
  style?: React.CSSProperties;
  appearance?: { elements?: Partial<SignInElements> };
  translations?: Partial<Translations>;
}
