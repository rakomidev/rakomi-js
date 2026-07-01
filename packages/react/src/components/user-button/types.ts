import type { Translations } from '../../i18n/types.js';

export interface UserButtonElements {
  root: string;
  avatar: string;
  menu: string;
  menuItem: string;
}

export interface UserButtonProps {
  locale?: 'en' | 'pl';
  afterSignOutUrl?: string;
  profileUrl?: string;
  showName?: boolean;
  className?: string;
  style?: React.CSSProperties;
  appearance?: { elements?: Partial<UserButtonElements> };
  translations?: Partial<Translations>;
  children?: React.ReactNode;
}
