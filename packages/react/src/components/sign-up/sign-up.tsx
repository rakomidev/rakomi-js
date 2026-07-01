'use client';

/**
 * <SignUp /> — Pre-built registration component.
 * Two-step: form → email verification.
 * Includes consent checkbox, password strength, email verification with resend.
 */

import React, { useEffect, useId, useRef, useState } from 'react';

import { PASSWORD_MIN_LENGTH } from '../../_inlined-symbols.js';

import { resolveClassName, useGlobalAppearance } from '../../appearance.js';
import { useAuth } from '../../hooks/use-auth.js';
import { useBranding } from '../../hooks/use-branding.js';
import { useTranslation } from '../../hooks/use-translation.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { applyBranding, hasBrandingStyles } from '../../internal/branding-styles.js';
import { PasswordInput } from '../../internal/password-input.js';
import { useColorScheme, useRakomiInternals } from '../../internal/use-auth-internals.js';
import { sdkFetch } from '../../lib/fetch-client.js';
import { resendVerification } from '../../oauth/profile.js';
import { registerUser } from '../../oauth/register.js';
import { getErrorMessage } from '../../types.js';
import { getPasswordStrength } from '../../utils/password-strength.js';
import { isSafeImageSrc, isSafeRedirectUrl } from '../../utils/safe-url.js';
import type { SignUpProps } from './types.js';

type SignUpStep = 'form' | 'verification_pending' | 'complete';

function SignUpInner(props: SignUpProps): React.ReactElement {
  const {
    title,
    logo,
    fallback,
    initialValues,
    locale,
    signInUrl,
    privacyPolicyUrl,
    termsOfServiceUrl,
    showConfirmPassword = true,
    redirectIfAuthenticated,
    afterSignUpUrl,
    onSignUp,
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
  const [step, setStep] = useState<SignUpStep>('form');
  const [email, setEmail] = useState(initialValues?.email ?? '');
  const passwordValueRef = useRef('');
  const [passwordStrength, setPasswordStrength] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const submitting = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [blurErrors, setBlurErrors] = useState<Partial<Record<'email' | 'password' | 'confirmPassword', string>>>({});
  const formSubmitted = useRef(false);

  const strength = getPasswordStrength(passwordStrength);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setTimeout(() => setResendCooldown(prev => prev - 1), 1000);
    timers.current.push(id);
    return () => clearTimeout(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (auth.isSignedIn && redirectIfAuthenticated && typeof window !== 'undefined') {
      if (isSafeRedirectUrl(redirectIfAuthenticated)) window.location.href = redirectIfAuthenticated;
    }
  }, [auth.isSignedIn, redirectIfAuthenticated]);

  useEffect(() => {
    if (step === 'complete') {
      if (afterSignUpUrl && typeof window !== 'undefined') {
        if (isSafeRedirectUrl(afterSignUpUrl)) window.location.href = afterSignUpUrl;
      } else {
        onSignUp?.();
      }
    }
  }, [step, afterSignUpUrl, onSignUp]);

  useEffect(() => {
    if (step === 'form') emailRef.current?.focus();
  }, []);

  const verifyStarted = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || verifyStarted.current) return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    const action = url.searchParams.get('action');
    if (token && action === 'verify_email') {
      verifyStarted.current = true;
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await sdkFetch(`${internals.baseUrl}/v1/auth/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': internals.clientId },
            body: JSON.stringify({ token }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (response.ok) {
            try {
              const data = await response.json() as Record<string, unknown>;
              if (controller.signal.aborted) return;
              if (data && typeof data === 'object') {
                url.searchParams.delete('token');
                url.searchParams.delete('action');
                window.history.replaceState(window.history.state, '', url.toString());
                setStep('complete');
              }
            } catch {
            }
          }
        } catch {
        }
      })();
      return () => {
        controller.abort();
      };
    }
    return undefined;
  }, [internals.baseUrl, internals.clientId]);

  const handleEmailBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = e.target.value.trim();
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      setBlurErrors(prev => ({ ...prev, email: t('signUp.emailInvalid') }));
    } else {
      setBlurErrors(prev => ({ ...prev, email: undefined }));
    }
  };

  const handlePasswordBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val && val.length < PASSWORD_MIN_LENGTH) {
      setBlurErrors(prev => ({ ...prev, password: t('signUp.passwordTooShort') }));
    } else {
      setBlurErrors(prev => ({ ...prev, password: undefined }));
    }
  };

  const handleConfirmPasswordBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const passwordVal = passwordRef.current?.value ?? '';
    if (val && val !== passwordVal) {
      setBlurErrors(prev => ({ ...prev, confirmPassword: t('signUp.passwordMismatch') }));
    } else {
      setBlurErrors(prev => ({ ...prev, confirmPassword: undefined }));
    }
  };

  if (auth.isSignedIn) {
    return <></>;
  }

  if (!auth.isLoaded) {
    if (fallback) return <>{fallback}</>;
    return (
      <div data-rakomi-sign-up-root data-rakomi-card aria-busy="true" className={className} style={style}>
        <div data-rakomi-skeleton>{t('common.loading')}</div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError(null);

    if (passwordRef.current?.value) {
      passwordValueRef.current = passwordRef.current.value;
    }
    const passwordValue = passwordValueRef.current;

    if (passwordValue.length < PASSWORD_MIN_LENGTH) {
      setError(t('signUp.passwordTooShort'));
      passwordRef.current?.focus();
      submitting.current = false;
      setLoading(false);
      return;
    }

    if (showConfirmPassword) {
      const confirmValue = confirmPasswordRef.current?.value ?? '';
      if (passwordValue !== confirmValue) {
        setError(t('signUp.passwordMismatch'));
        confirmPasswordRef.current?.focus();
        submitting.current = false;
        setLoading(false);
        return;
      }
    }

    formSubmitted.current = true;
    if (!consent) {
      setError(t('signUp.consentRequired'));
      submitting.current = false;
      setLoading(false);
      return;
    }

    try {
      const result = await registerUser({
        baseUrl: internals.baseUrl,
        email,
        password: passwordValue,
        consent: true,
        apiKey: internals.clientId,
      });

      if (result.ok) {
        setStep('verification_pending');
        setResendCooldown(60);
      } else {
        setError(getErrorMessage(result.error));
      }
    } catch {
      setError(t('error.unknownError'));
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (resendCooldown > 0) return;

    try {
      const result = await resendVerification({
        baseUrl: internals.baseUrl,
        email,
        apiKey: internals.clientId,
      });
      if (result.ok) {
        setResendCooldown(60);
      } else if (result.error.code === 'NETWORK_ERROR') {
        setError(t('error.networkError'));
      } else {
        setResendCooldown(60);
      }
    } catch {
      setError(t('error.networkError'));
    }
  };

  const strengthKey = `signUp.passwordStrength.${strength === 'very_strong' ? 'veryStrong' : strength}` as const;

  const termsUrlSafe = termsOfServiceUrl && isSafeRedirectUrl(termsOfServiceUrl);
  const privacyUrlSafe = privacyPolicyUrl && isSafeRedirectUrl(privacyPolicyUrl);

  if (step === 'verification_pending') {
    return (
      <div data-rakomi-sign-up-root data-rakomi-card className={[cls('root'), className].filter(Boolean).join(' ') || undefined} style={style}>
        <h2 data-rakomi-sign-up-title>{t('signUp.verifyTitle')}</h2>
        <p aria-live="polite">{t('signUp.verifyMessage', { email })}</p>
        <p>{t('signUp.verifyCheckSpam')}</p>
        <button
          type="button"
          onClick={() => void handleResendVerification()}
          disabled={resendCooldown > 0}
          data-rakomi-sign-up-link
        >
          {resendCooldown > 0
            ? `${t('signUp.resend')} (${resendCooldown}s)`
            : t('signUp.resend')}
        </button>
        {error && <div role="alert" data-rakomi-sign-up-error className={cls('errorMessage') || undefined}>{error}</div>}
        {signInUrl && isSafeRedirectUrl(signInUrl) && (
          <p data-rakomi-sign-up-link>
            {t('signUp.existingAccountHint', { link: '' })}
            <a href={signInUrl}>{t('signIn.title')}</a>
          </p>
        )}
      </div>
    );
  }

  return (
    <div data-rakomi-sign-up-root data-rakomi-card data-rakomi-theme={colorScheme !== 'auto' ? colorScheme : undefined} data-rakomi-branded={hasBrandingStyles(branding) || undefined} className={[cls('root'), className].filter(Boolean).join(' ') || undefined} style={{ ...applyBranding(branding), ...style }}>
      {logo && isSafeImageSrc(logo.src) ? (
        <img
          src={logo.src}
          alt={logo.alt}
          data-rakomi-sign-up-logo
        />
      ) : branding?.logoUrl && isSafeImageSrc(branding.logoUrl) ? (
        <img
          src={branding.logoUrl}
          alt={branding.tenantName}
          data-rakomi-sign-up-logo
          fetchPriority="low"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ) : null}
      {typeof title === 'string' ? (
        <h2 data-rakomi-sign-up-title>{title}</h2>
      ) : title ? (
        <div data-rakomi-sign-up-title>{title}</div>
      ) : (
        <h2 data-rakomi-sign-up-title>
          {branding?.tenantName ? t('signUp.titleBranded', { name: branding.tenantName }) : t('signUp.title')}
        </h2>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate data-rakomi-sign-up-form className={cls('form') || undefined} aria-busy={loading}>
        <div data-rakomi-field className={cls('field') || undefined}>
          <label htmlFor={`${idPrefix}-sign-up-email`}>{t('signIn.emailLabel')}</label>
          <input
            ref={emailRef}
            id={`${idPrefix}-sign-up-email`}
            name="email"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            disabled={loading}
            value={email}
            onChange={e => { setEmail(e.target.value); setBlurErrors(prev => ({ ...prev, email: undefined })); }}
            onBlur={handleEmailBlur}
            aria-describedby={blurErrors.email ? `${idPrefix}-signup-email-error` : error ? `${idPrefix}-sign-up-error` : undefined}
            aria-invalid={blurErrors.email ? true : undefined}
            className={cls('input') || undefined}
          />
          {blurErrors.email && (
            <div id={`${idPrefix}-signup-email-error`} data-rakomi-error className={cls('errorMessage') || undefined}>
              {blurErrors.email}
            </div>
          )}
        </div>

        <PasswordInput
          name="password"
          label={t('signIn.passwordLabel')}
          autoComplete="new-password"
          disabled={loading}
          inputRef={passwordRef}
          t={t}
          error={blurErrors.password}
          onChange={(val: string) => { passwordValueRef.current = val; setPasswordStrength(val); setBlurErrors(prev => ({ ...prev, password: undefined })); }}
          onBlur={handlePasswordBlur}
          data-rakomi="sign-up-password"
        />

        {passwordStrength.length > 0 && (
          <div data-rakomi-sign-up-strength-bar aria-label={`Password strength: ${strength}`}>
            <div data-rakomi-strength-level={strength} />
            <span>{t(strengthKey)}</span>
          </div>
        )}

        {showConfirmPassword && (
          <PasswordInput
            name="confirmPassword"
            label={t('userProfile.confirmPassword')}
            autoComplete="new-password"
            disabled={loading}
            inputRef={confirmPasswordRef}
            t={t}
            error={blurErrors.confirmPassword}
            onChange={() => { setBlurErrors(prev => ({ ...prev, confirmPassword: undefined })); }}
            onBlur={handleConfirmPasswordBlur}
            data-rakomi="sign-up-confirm-password"
          />
        )}

        <div data-rakomi-sign-up-consent className={cls('consentCheckbox') || undefined}>
          <label>
            <input
              type="checkbox"
              name="consent"
              checked={consent}
              onChange={e => setConsent(e.target.checked)}
              required
            />
            {privacyPolicyUrl && termsOfServiceUrl ? (
              <span>
                {t('signUp.consentLabel', { termsLink: '', privacyLink: '' })}{' '}
                {termsUrlSafe ? (
                  <a href={termsOfServiceUrl} target="_blank" rel="noopener noreferrer">{t('signUp.termsOfService')}</a>
                ) : (
                  <span>{t('signUp.termsOfService')}</span>
                )}
                {' & '}
                {privacyUrlSafe ? (
                  <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer">{t('signUp.privacyPolicy')}</a>
                ) : (
                  <span>{t('signUp.privacyPolicy')}</span>
                )}
              </span>
            ) : (
              <span>{t('signUp.consentLabel', { termsLink: t('signUp.termsOfService'), privacyLink: t('signUp.privacyPolicy') })}</span>
            )}
          </label>
        </div>

        <p data-rakomi-sign-up-data-location>{t('signUp.dataLocation')}</p>

        {error && (
          <div id={`${idPrefix}-sign-up-error`} role="alert" data-rakomi-sign-up-error className={cls('errorMessage') || undefined}>{error}</div>
        )}

        <button type="submit" disabled={loading || !consent} data-rakomi-sign-up-submit-button className={cls('submitButton') || undefined}>
          {loading ? t('common.loading') : t('signUp.consentLink')}
        </button>
      </form>

      {signInUrl && isSafeRedirectUrl(signInUrl) && (
        <p data-rakomi-sign-up-link>
          {t('signUp.hasAccount', { link: '' })}
          <a href={signInUrl}>{t('signIn.title')}</a>
        </p>
      )}
    </div>
  );
}

export function SignUp(props: SignUpProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <SignUpInner {...props} />
    </AuthErrorBoundary>
  );
}
