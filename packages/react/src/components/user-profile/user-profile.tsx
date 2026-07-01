'use client';

/**
 * <UserProfile /> — Account settings: password, MFA, sessions.
 * Sectioned layout with password change, MFA setup/disable, session management.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { resolveClassName, useGlobalAppearance } from '../../appearance.js';
import { useAuth } from '../../hooks/use-auth.js';
import { useBranding } from '../../hooks/use-branding.js';
import { useTranslation } from '../../hooks/use-translation.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { applyBranding, hasBrandingStyles } from '../../internal/branding-styles.js';
import { PasswordInput } from '../../internal/password-input.js';
import { useColorScheme, useRakomiInternals } from '../../internal/use-auth-internals.js';
import {
  changePassword,
  disableMfa,
  fetchSessions,
  regenerateRecoveryCodes,
  revokeAllOtherSessions,
  revokeSession,
  setupMfa,
  verifyMfaSetup,
} from '../../oauth/profile.js';
import type { SessionInfo } from '../../types.js';
import { getErrorMessage } from '../../types.js';
import { copyToClipboard } from '../../utils/copy-to-clipboard.js';
import { getPasswordStrength } from '../../utils/password-strength.js';
import type { UserProfileProps } from './types.js';

type MfaState = 'idle' | 'setup_qr' | 'setup_verify' | 'recovery_codes' | 'disable_confirm' | 'regenerate_confirm';

function UserProfileInner(props: UserProfileProps): React.ReactElement | null {
  const {
    title,
    locale,
    sections = ['password', 'mfa', 'sessions'],
    className,
    style,
    translations,
  } = props;

  const auth = useAuth();
  const internals = useRakomiInternals();
  const { branding } = useBranding();
  const t = useTranslation(locale, undefined, translations);
  const globalAppearance = useGlobalAppearance();
  const colorScheme = useColorScheme();
  const cls = (element: string) => resolveClassName(element, props.appearance, globalAppearance);
  const idPrefix = useId();

  const [pwLoading, setPwLoading] = useState(false);
  const [pwMessage, setPwMessage] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwStrengthValue, setPwStrengthValue] = useState('');
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const [mfaState, setMfaState] = useState<MfaState>('idle');
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const mfaCodeRef = useRef<HTMLInputElement>(null);
  const mfaPasswordRef = useRef<HTMLInputElement>(null);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokeErrors, setRevokeErrors] = useState<Record<string, string>>({});

  const getTokenRef = useRef(auth.getToken);
  getTokenRef.current = auth.getToken;

  const getToken = useCallback(async (): Promise<string | null> => {
    const tokenResult = await getTokenRef.current();
    if (!tokenResult.ok) {
      return null;
    }
    return tokenResult.token;
  }, []);

  const pwSubmitting = useRef(false);
  const mfaSubmitting = useRef(false);

  const handlePasswordChange = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pwSubmitting.current) return;
    pwSubmitting.current = true;
    setPwLoading(true);
    setPwError(null);
    setPwMessage(null);

    const currentPassword = currentPasswordRef.current?.value ?? '';
    const newPassword = newPasswordRef.current?.value ?? '';
    const confirmPassword = confirmPasswordRef.current?.value ?? '';

    if (newPassword !== confirmPassword) {
      setPwError(t('signUp.passwordMismatch'));
      setPwLoading(false);
      pwSubmitting.current = false;
      return;
    }

    const token = await getToken();
    if (!token) {
      setPwError(t('userProfile.sessionExpired'));
      setPwLoading(false);
      pwSubmitting.current = false;
      return;
    }

    try {
      const result = await changePassword({
        baseUrl: internals.baseUrl,
        token,
        currentPassword,
        newPassword,
      });

      if (result.ok) {
        setPwMessage(t('userProfile.passwordChanged'));
        if (currentPasswordRef.current) currentPasswordRef.current.value = '';
        if (newPasswordRef.current) newPasswordRef.current.value = '';
        if (confirmPasswordRef.current) confirmPasswordRef.current.value = '';
      } else {
        setPwError(getErrorMessage(result.error));
      }
    } catch {
      setPwError(t('error.unknownError'));
    } finally {
      pwSubmitting.current = false;
      setPwLoading(false);
    }
  }, [internals.baseUrl, t, getToken]);

  const handleMfaSetup = useCallback(async () => {
    if (mfaSubmitting.current) return;
    mfaSubmitting.current = true;
    setMfaLoading(true);
    setMfaError(null);

    const token = await getToken();
    if (!token) {
      setMfaError(t('userProfile.sessionExpired'));
      setMfaLoading(false);
      mfaSubmitting.current = false;
      return;
    }

    try {
      const result = await setupMfa({ baseUrl: internals.baseUrl, token });

      if (result.ok) {
        if (result.qrCode.startsWith('data:image/') && result.qrCode.length < 102400) {
          setQrCode(result.qrCode);
        }
        setMfaSecret(result.secret);
        setRecoveryCodes(result.recoveryCodes);
        setMfaState('setup_qr');
      } else {
        setMfaError(getErrorMessage(result.error));
      }
    } catch {
      setMfaError(t('error.unknownError'));
    } finally {
      mfaSubmitting.current = false;
      setMfaLoading(false);
    }
  }, [internals.baseUrl, t, getToken]);

  const handleMfaVerifySetup = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mfaSubmitting.current) return;
    mfaSubmitting.current = true;
    setMfaLoading(true);
    setMfaError(null);

    const code = (mfaCodeRef.current?.value ?? '').trim();
    const token = await getToken();
    if (!token) {
      setMfaError(t('userProfile.sessionExpired'));
      setMfaLoading(false);
      mfaSubmitting.current = false;
      return;
    }

    try {
      const result = await verifyMfaSetup({ baseUrl: internals.baseUrl, token, code });

      if (result.ok) {
        setRecoveryCodes(result.recoveryCodes);
        setMfaState('recovery_codes');
      } else {
        setMfaError(getErrorMessage(result.error));
      }
    } catch {
      setMfaError(t('error.unknownError'));
    } finally {
      mfaSubmitting.current = false;
      setMfaLoading(false);
    }
  }, [internals.baseUrl, t, getToken]);

  const handleMfaDisable = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mfaSubmitting.current) return;
    mfaSubmitting.current = true;
    setMfaLoading(true);
    setMfaError(null);

    const password = mfaPasswordRef.current?.value ?? '';
    const token = await getToken();
    if (!token) {
      setMfaError(t('userProfile.sessionExpired'));
      setMfaLoading(false);
      mfaSubmitting.current = false;
      return;
    }

    try {
      const result = await disableMfa({ baseUrl: internals.baseUrl, token, password });

      if (result.ok) {
        setMfaState('idle');
      } else {
        setMfaError(getErrorMessage(result.error));
      }
    } catch {
      setMfaError(t('error.unknownError'));
    } finally {
      mfaSubmitting.current = false;
      setMfaLoading(false);
    }
  }, [internals.baseUrl, t, getToken]);

  const handleRegenerateCodes = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mfaSubmitting.current) return;
    mfaSubmitting.current = true;
    setMfaLoading(true);
    setMfaError(null);

    const password = mfaPasswordRef.current?.value ?? '';
    const token = await getToken();
    if (!token) {
      setMfaError(t('userProfile.sessionExpired'));
      setMfaLoading(false);
      mfaSubmitting.current = false;
      return;
    }

    try {
      const result = await regenerateRecoveryCodes({ baseUrl: internals.baseUrl, token, password });

      if (result.ok) {
        setRecoveryCodes(result.recoveryCodes);
        setMfaState('recovery_codes');
      } else {
        setMfaError(getErrorMessage(result.error));
      }
    } catch {
      setMfaError(t('error.unknownError'));
    } finally {
      mfaSubmitting.current = false;
      setMfaLoading(false);
    }
  }, [internals.baseUrl, t, getToken]);

  const tRef = useRef(t);
  tRef.current = t;

  const handleFetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);

    const token = await getToken();
    if (!token) {
      setSessionsError(tRef.current('userProfile.sessionExpired'));
      setSessionsLoading(false);
      return;
    }

    try {
      const result = await fetchSessions({ baseUrl: internals.baseUrl, token });

      if (result.ok) {
        setSessions(result.sessions);
      } else {
        setSessionsError(getErrorMessage(result.error));
      }
    } catch {
      setSessionsError(tRef.current('error.unknownError'));
    } finally {
      setSessionsLoading(false);
    }
  }, [internals.baseUrl, getToken]);

  useEffect(() => {
    if (sections.includes('sessions') && auth.isSignedIn) {
      void handleFetchSessions();
    }
  }, [sections, auth.isSignedIn, handleFetchSessions]);

  const handleRevokeSession = useCallback(async (sessionId: string) => {
    setRevokeErrors(prev => { const next = { ...prev }; delete next[sessionId]; return next; });

    const token = await getToken();
    if (!token) return;

    try {
      const result = await revokeSession({ baseUrl: internals.baseUrl, token, sessionId });
      if (result.ok) {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
      } else {
        setRevokeErrors(prev => ({ ...prev, [sessionId]: getErrorMessage(result.error) }));
      }
    } catch {
      setRevokeErrors(prev => ({ ...prev, [sessionId]: t('error.unknownError') }));
    }
  }, [internals.baseUrl, t, getToken]);

  const handleRevokeAllOther = useCallback(async () => {
    const token = await getToken();
    if (!token) return;

    const otherSessionIds = sessions.filter(s => !s.isCurrent).map(s => s.id);

    try {
      const result = await revokeAllOtherSessions({ baseUrl: internals.baseUrl, token, sessionIds: otherSessionIds });
      if (result.ok) {
        if (result.failedCount > 0) {
          setSessions(prev => prev.filter(s => s.isCurrent || result.failedSessionIds.includes(s.id)));
          setSessionsError(t('userProfile.sessionRevokePartial', { count: String(result.failedCount) }));
        } else {
          setSessions(prev => prev.filter(s => s.isCurrent));
        }
      } else {
        setSessionsError(getErrorMessage(result.error));
      }
    } catch {
      setSessionsError(t('error.unknownError'));
    }
  }, [internals.baseUrl, t, getToken, sessions]);

  const validCodePattern = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;
  const filteredRecoveryCodes = recoveryCodes.filter(c => validCodePattern.test(c));

  const handleCopyRecoveryCodes = useCallback(async () => {
    const text = filteredRecoveryCodes.join('\n');
    await copyToClipboard(text);
  }, [filteredRecoveryCodes]);

  if (!auth.isLoaded || !auth.isSignedIn) return null;

  const renderMfaSection = () => {
    switch (mfaState) {
      case 'idle': {
        const userHasMfa = auth.user?.mfaVerified === true;
        return (
          <>
            {!userHasMfa && (
              <button type="button" onClick={() => void handleMfaSetup()} disabled={mfaLoading} data-rakomi-user-profile-mfa-setup>
                {mfaLoading ? t('common.loading') : t('userProfile.mfaSetup')}
              </button>
            )}
            {userHasMfa && (
              <>
                <button type="button" onClick={() => setMfaState('disable_confirm')} data-rakomi-user-profile-mfa-disable>
                  {t('userProfile.mfaDisable')}
                </button>
                <button type="button" onClick={() => setMfaState('regenerate_confirm')} data-rakomi-user-profile-mfa-regenerate>
                  {t('userProfile.mfaRecoveryCodes')}
                </button>
              </>
            )}
            {mfaError && <div role="alert" data-rakomi-user-profile-error>{mfaError}</div>}
          </>
        );
      }

      case 'setup_qr':
        return (
          <>
            {qrCode && (
              <img
                src={qrCode}
                alt="Scan this QR code with your authenticator app"
                data-rakomi-user-profile-qr-code
                className={cls('qrCode') || undefined}
                style={{ minWidth: 200, minHeight: 200, maxWidth: '100%' }}
              />
            )}
            <details data-rakomi-user-profile-manual-entry>
              <summary>{t('userProfile.mfaManualEntry')}</summary>
              <code data-rakomi-user-profile-secret>{mfaSecret}</code>
              <button type="button" onClick={() => void copyToClipboard(mfaSecret)}>
                {t('common.copy')}
              </button>
            </details>
            <form onSubmit={(e) => void handleMfaVerifySetup(e)} data-rakomi-user-profile-form>
              <div data-rakomi-field>
                <label htmlFor={`${idPrefix}-mfa-verify-code`}>{t('signIn.mfa.codeLabel')}</label>
                <input
                  ref={mfaCodeRef}
                  id={`${idPrefix}-mfa-verify-code`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </div>
              {mfaError && <div role="alert" data-rakomi-user-profile-error>{mfaError}</div>}
              <button type="submit" disabled={mfaLoading} data-rakomi-user-profile-submit className={cls('submitButton') || undefined}>
                {mfaLoading ? t('common.loading') : t('common.save')}
              </button>
            </form>
            <button type="button" onClick={() => { setMfaState('idle'); setMfaSecret(''); setQrCode(''); }} data-rakomi-user-profile-link>
              {t('common.cancel')}
            </button>
          </>
        );

      case 'recovery_codes':
        return (
          <>
            <p aria-live="polite" data-rakomi-user-profile-recovery-warning>
              {t('userProfile.mfaRecoveryWarning')}
            </p>
            <div data-rakomi-user-profile-recovery-grid className={cls('recoveryGrid') || undefined}>
              {}
              {filteredRecoveryCodes.map(code => (
                <code key={code}>{code}</code>
              ))}
            </div>
            <button type="button" onClick={() => void handleCopyRecoveryCodes()}>
              {t('common.copy')}
            </button>
            <button type="button" onClick={() => { if (typeof window !== 'undefined') window.print(); }} data-rakomi-user-profile-print>
              {t('userProfile.mfaRecoveryPrint')}
            </button>
            <button type="button" onClick={() => { setRecoveryCodes([]); setMfaState('idle'); }} data-rakomi-user-profile-link>
              {t('common.back')}
            </button>
          </>
        );

      case 'disable_confirm':
        return (
          <form onSubmit={(e) => void handleMfaDisable(e)} data-rakomi-user-profile-form>
            <p>{t('userProfile.mfaDisable')}</p>
            <PasswordInput
              name="disablePassword"
              label={t('signIn.passwordLabel')}
              autoComplete="current-password"
              disabled={mfaLoading}
              inputRef={mfaPasswordRef}
              t={t}
            />
            {mfaError && <div role="alert" data-rakomi-user-profile-error>{mfaError}</div>}
            <button type="submit" disabled={mfaLoading} data-rakomi-user-profile-submit className={cls('submitButton') || undefined}>
              {mfaLoading ? t('common.loading') : t('userProfile.mfaDisable')}
            </button>
            <button type="button" onClick={() => setMfaState('idle')} data-rakomi-user-profile-link>
              {t('common.cancel')}
            </button>
          </form>
        );

      case 'regenerate_confirm':
        return (
          <form onSubmit={(e) => void handleRegenerateCodes(e)} data-rakomi-user-profile-form>
            <p>{t('userProfile.mfaRecoveryCodes')}</p>
            <PasswordInput
              name="regeneratePassword"
              label={t('signIn.passwordLabel')}
              autoComplete="current-password"
              disabled={mfaLoading}
              inputRef={mfaPasswordRef}
              t={t}
            />
            {mfaError && <div role="alert" data-rakomi-user-profile-error>{mfaError}</div>}
            <button type="submit" disabled={mfaLoading} data-rakomi-user-profile-submit className={cls('submitButton') || undefined}>
              {mfaLoading ? t('common.loading') : t('userProfile.mfaRecoveryCodes')}
            </button>
            <button type="button" onClick={() => setMfaState('idle')} data-rakomi-user-profile-link>
              {t('common.cancel')}
            </button>
          </form>
        );

      default:
        return null;
    }
  };

  const resolvedLocale = locale ?? 'en';
  const rtfRef = useRef<{ formatter: Intl.RelativeTimeFormat; locale: string } | null>(null);
  const getFormatter = useCallback(() => {
    if (!rtfRef.current || rtfRef.current.locale !== resolvedLocale) {
      rtfRef.current = { formatter: new Intl.RelativeTimeFormat(resolvedLocale, { numeric: 'auto' }), locale: resolvedLocale };
    }
    return rtfRef.current.formatter;
  }, [resolvedLocale]);
  const formatRelativeTime = (dateStr: string): string => {
    try {
      const diff = Date.now() - new Date(dateStr).getTime();
      const seconds = Math.floor(diff / 1000);
      const rtf = getFormatter();
      if (seconds < 60) return rtf.format(-seconds, 'second');
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return rtf.format(-minutes, 'minute');
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return rtf.format(-hours, 'hour');
      const days = Math.floor(hours / 24);
      if (days < 7) return rtf.format(-days, 'day');
      return new Date(dateStr).toLocaleDateString(resolvedLocale);
    } catch {
      return dateStr;
    }
  };

  return (
    <div data-rakomi-user-profile-root data-rakomi-card data-rakomi-theme={colorScheme !== 'auto' ? colorScheme : undefined} data-rakomi-branded={hasBrandingStyles(branding) || undefined} className={[cls('root'), className].filter(Boolean).join(' ') || undefined} style={{ ...applyBranding(branding), ...style }}>
      {typeof title === 'string' ? (
        <h2 data-rakomi-user-profile-title>{title}</h2>
      ) : title ? (
        <div data-rakomi-user-profile-title>{title}</div>
      ) : (
        <h2 data-rakomi-user-profile-title>{t('userProfile.title')}</h2>
      )}

      {sections.includes('password') && (
        <section data-rakomi-user-profile-section="password">
          <h3>{t('userProfile.passwordSection')}</h3>
          <form onSubmit={(e) => void handlePasswordChange(e)} data-rakomi-user-profile-form aria-busy={pwLoading}>
            <PasswordInput
              name="currentPassword"
              label={t('userProfile.currentPassword')}
              autoComplete="current-password"
              disabled={pwLoading}
              inputRef={currentPasswordRef}
              t={t}
            />
            <PasswordInput
              name="newPassword"
              label={t('userProfile.newPassword')}
              autoComplete="new-password"
              disabled={pwLoading}
              inputRef={newPasswordRef}
              t={t}
              onChange={(val: string) => setPwStrengthValue(val)}
            />
            {pwStrengthValue.length > 0 && (() => {
              const strength = getPasswordStrength(pwStrengthValue);
              const strengthKey = `signUp.passwordStrength.${strength === 'very_strong' ? 'veryStrong' : strength}` as const;
              return (
                <div data-rakomi-user-profile-strength-bar aria-label={`Password strength: ${strength}`}>
                  <div data-rakomi-strength-level={strength} />
                  <span>{t(strengthKey)}</span>
                </div>
              );
            })()}
            <PasswordInput
              name="confirmPassword"
              label={t('userProfile.confirmPassword')}
              autoComplete="new-password"
              disabled={pwLoading}
              inputRef={confirmPasswordRef}
              t={t}
            />
            {pwError && <div role="alert" data-rakomi-user-profile-error>{pwError}</div>}
            {pwMessage && <div role="status" data-rakomi-user-profile-success>{pwMessage}</div>}
            <button type="submit" disabled={pwLoading} data-rakomi-user-profile-submit className={cls('submitButton') || undefined}>
              {pwLoading ? t('common.loading') : t('common.save')}
            </button>
          </form>
        </section>
      )}

      {sections.includes('mfa') && (
        <section data-rakomi-user-profile-section="mfa">
          <h3>{t('userProfile.mfaSection')}</h3>
          {renderMfaSection()}
        </section>
      )}

      {sections.includes('sessions') && (
        <section data-rakomi-user-profile-section="sessions">
          <h3>{t('userProfile.sessionsSection')}</h3>
          {sessionsLoading && <p aria-busy="true">{t('common.loading')}</p>}
          {sessionsError && <div role="alert" data-rakomi-user-profile-error>{sessionsError}</div>}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <p>{t('userProfile.noOtherSessions')}</p>
          )}
          {sessions.map(session => (
            <div key={session.id} data-rakomi-user-profile-session-card className={cls('sessionCard') || undefined}>
              <div>
                <span>{session.userAgent || 'Unknown device'}</span>
                {session.ipHash && <span> · {session.ipHash.slice(0, 8)}</span>}
              </div>
              <div>
                <span>{formatRelativeTime(session.lastUsedAt)}</span>
                {session.isCurrent && (
                  <span data-rakomi-user-profile-session-current>
                    {t('userProfile.sessionCurrent')}
                  </span>
                )}
              </div>
              {!session.isCurrent && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleRevokeSession(session.id)}
                    data-rakomi-user-profile-session-revoke
                  >
                    {t('userProfile.sessionRevoke')}
                  </button>
                  {}
                  {revokeErrors[session.id] && (
                    <div role="alert" data-rakomi-user-profile-error>
                      {revokeErrors[session.id]}
                      <button type="button" onClick={() => void handleRevokeSession(session.id)}>
                        {t('common.retry')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {sessions.filter(s => !s.isCurrent).length > 0 && (
            <button
              type="button"
              onClick={() => void handleRevokeAllOther()}
              data-rakomi-user-profile-session-revoke-all
            >
              {t('userProfile.sessionRevokeAll')}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

export function UserProfile(props: UserProfileProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <UserProfileInner {...props} />
    </AuthErrorBoundary>
  );
}
