import type { Translations } from '../../i18n/types.js';

export interface SignUpElements {
  root: string;
  form: string;
  title: string;
  field: string;
  label: string;
  input: string;
  passwordToggle: string;
  strengthBar: string;
  consentCheckbox: string;
  submitButton: string;
  errorMessage: string;
  link: string;
}

export interface SignUpProps {
  title?: string | React.ReactNode;
  logo?: { src: string; alt: string };
  fallback?: React.ReactNode;
  initialValues?: { email?: string };
  locale?: 'en' | 'pl';
  signInUrl?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  showConfirmPassword?: boolean;
  redirectIfAuthenticated?: string;
  afterSignUpUrl?: string;
  onSignUp?: () => void;
  className?: string;
  style?: React.CSSProperties;
  appearance?: { elements?: Partial<SignUpElements> };
  translations?: Partial<Translations>;
}
