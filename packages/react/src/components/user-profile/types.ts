import type { Translations } from '../../i18n/types.js';

export interface UserProfileElements {
  root: string;
  title: string;
  section: string;
  field: string;
  passwordToggle: string;
  qrCode: string;
  recoveryGrid: string;
  sessionCard: string;
  submitButton: string;
  errorMessage: string;
}

export interface UserProfileProps {
  title?: string | React.ReactNode;
  locale?: 'en' | 'pl';
  sections?: ('password' | 'mfa' | 'sessions')[];
  className?: string;
  style?: React.CSSProperties;
  appearance?: { elements?: Partial<UserProfileElements> };
  translations?: Partial<Translations>;
}
