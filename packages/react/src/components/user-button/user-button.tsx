'use client';

/**
 * <UserButton /> — Avatar button + dropdown menu.
 * Disclosure pattern (NOT Menu pattern per APG).
 * Shows user email, optional manage link, sign out.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { resolveClassName, useGlobalAppearance } from '../../appearance.js';
import { useAuth } from '../../hooks/use-auth.js';
import { useBranding } from '../../hooks/use-branding.js';
import { useTranslation } from '../../hooks/use-translation.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { applyBranding, hasBrandingStyles } from '../../internal/branding-styles.js';
import { useColorScheme } from '../../internal/use-auth-internals.js';
import { isSafeRedirectUrl } from '../../utils/safe-url.js';
import type { UserButtonProps } from './types.js';

function UserButtonInner(props: UserButtonProps): React.ReactElement | null {
  const {
    locale,
    afterSignOutUrl,
    profileUrl,
    showName = false,
    className,
    style,
    translations,
    children,
  } = props;

  const auth = useAuth();
  const { branding } = useBranding();
  const t = useTranslation(locale, undefined, translations);
  const globalAppearance = useGlobalAppearance();
  const colorScheme = useColorScheme();
  const cls = (element: string) => resolveClassName(element, props.appearance, globalAppearance);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownId = useId();
  const signingOut = useRef(false);

  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const handleSignOut = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setOpen(false);
    try {
      await auth.signOut();
      if (afterSignOutUrl && typeof window !== 'undefined') {
        if (isSafeRedirectUrl(afterSignOutUrl)) window.location.href = afterSignOutUrl;
      }
    } finally {
      signingOut.current = false;
    }
  }, [auth, afterSignOutUrl]);

  if (!auth.isLoaded || !auth.isSignedIn) return null;

  const email = auth.user?.email ?? '';
  const initial = email.charAt(0).toUpperCase();

  return (
    <div data-rakomi-user-button-root data-rakomi-theme={colorScheme !== 'auto' ? colorScheme : undefined} data-rakomi-branded={hasBrandingStyles(branding) || undefined} className={[cls('root'), className].filter(Boolean).join(' ') || undefined} style={{ ...applyBranding(branding), ...style }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-controls={dropdownId}
        data-rakomi-user-button-avatar
        className={cls('avatar') || undefined}
      >
        <span data-rakomi-user-button-initial>{initial}</span>
        {showName && <span data-rakomi-user-button-name>{email}</span>}
      </button>

      {open && (
        <div ref={menuRef} id={dropdownId} role="menu" data-rakomi-user-button-menu className={cls('menu') || undefined}>
          <div data-rakomi-user-button-email>{email}</div>

          {profileUrl && isSafeRedirectUrl(profileUrl) && (
            <a href={profileUrl} role="menuitem" data-rakomi-user-button-menu-item className={cls('menuItem') || undefined}>
              {t('userButton.manage')}
            </a>
          )}

          {children}

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            data-rakomi-user-button-menu-item
            className={cls('menuItem') || undefined}
          >
            {t('userButton.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

export function UserButton(props: UserButtonProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <UserButtonInner {...props} />
    </AuthErrorBoundary>
  );
}
