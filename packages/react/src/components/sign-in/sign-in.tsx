'use client';

/**
 * <SignIn /> — Pre-built sign-in component.
 * Multi-step state machine: idle → email_password / magic_link_sent / email_otp_sent / social_redirect / forgot_password / reset_password → mfa_required → complete.
 * Headless by default — semantic HTML with data-rakomi-* attributes.
 */

import React, { useEffect, useId, useReducer, useRef } from 'react';

import { resolveClassName, useGlobalAppearance } from '../../appearance.js';
import { useAuth } from '../../hooks/use-auth.js';
import { useAuthConfig } from '../../hooks/use-auth-config.js';
import { useBranding } from '../../hooks/use-branding.js';
import { useTranslation } from '../../hooks/use-translation.js';
import { AuthErrorBoundary } from '../../internal/auth-error-boundary.js';
import { applyBranding, hasBrandingStyles } from '../../internal/branding-styles.js';
import { PasswordInput } from '../../internal/password-input.js';
import { useColorScheme, useRakomiInternals } from '../../internal/use-auth-internals.js';
import { sendEmailOtp, verifyEmailOtpCode } from '../../oauth/email-otp.js';
import { sendMagicLink, verifyMagicLinkToken } from '../../oauth/magic-link.js';
import { verifyMfaLogin } from '../../oauth/mfa.js';
import { sendForgotPassword, submitResetPassword } from '../../oauth/password-reset.js';
import { generatePKCE } from '../../oauth/pkce.js';
import { buildSocialAuthorizeUrl } from '../../oauth/social-auth.js';
import { generateState } from '../../oauth/state.js';
import { getErrorMessage } from '../../types.js';
import { isSafeImageSrc, isSafeRedirectUrl } from '../../utils/safe-url.js';
import type { SignInAction, SignInProps, SignInState } from './types.js';

function setSessionItem(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(key, value); } catch { }
}

const initialState: SignInState = {
  step: 'idle',
  email: '',
  activeMethod: null,
  challengeToken: '',
  mfaExpiresIn: 0,
  mfaAttempts: 0,
  mfaUseRecovery: false,
  error: null,
  loading: false,
  resendAfterSeconds: 0,
  resendSeq: 0,
  otpExpiresAt: '',
  socialProvider: '',
  forgotPasswordSuccess: false,
  resetPasswordSuccess: false,
};

function reducer(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, step: action.step, error: null };
    case 'SET_EMAIL':
      return { ...state, email: action.email };
    case 'SET_ACTIVE_METHOD':
      return { ...state, activeMethod: action.activeMethod };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_MFA':
      return { ...state, step: 'mfa_required', challengeToken: action.challengeToken, mfaExpiresIn: action.expiresIn, mfaAttempts: 0 };
    case 'INCREMENT_MFA_ATTEMPTS':
      return { ...state, mfaAttempts: state.mfaAttempts + 1 };
    case 'RESET_MFA_ATTEMPTS':
      return { ...state, mfaAttempts: 0 };
    case 'TOGGLE_MFA_RECOVERY':
      return { ...state, mfaUseRecovery: !state.mfaUseRecovery, error: null };
    case 'SET_MAGIC_LINK_SENT':
      return { ...state, step: 'magic_link_sent', resendAfterSeconds: action.resendAfterSeconds, loading: false };
    case 'RESEND_SENT':
      return { ...state, resendAfterSeconds: action.resendAfterSeconds, resendSeq: state.resendSeq + 1, error: null };
    case 'SET_OTP_SENT':
      return { ...state, step: 'email_otp_sent', resendAfterSeconds: action.resendAfterSeconds, otpExpiresAt: action.expiresAt, loading: false };
    case 'SET_SOCIAL_REDIRECT':
      return { ...state, step: 'social_redirect', socialProvider: action.provider };
    case 'SET_FORGOT_PASSWORD_SUCCESS':
      return { ...state, forgotPasswordSuccess: true, loading: false };
    case 'SET_RESET_PASSWORD_SUCCESS':
      return { ...state, resetPasswordSuccess: true, loading: false };
    case 'RESET':
      return { ...initialState, email: state.email, activeMethod: null };
    default:
      return state;
  }
}

function SignInInner(props: SignInProps): React.ReactElement {
  const {
    title,
    logo,
    fallback,
    initialValues,
    methods: methodsProp,
    socialProviders: socialProp,
    socialPosition = 'top',
    locale,
    signUpUrl,
    forgotPasswordUrl,
    showRememberMe = false,
    redirectIfAuthenticated,
    initialMethod,
    afterSignInUrl,
    onSignIn,
    className,
    style,
    translations,
  } = props;

  const auth = useAuth();
  const internals = useRakomiInternals();
  const { config, isLoading: configLoading, error: configError } = useAuthConfig();
  const { branding } = useBranding();
  const t = useTranslation(locale, undefined, translations);
  const tRef = useRef(t);
  tRef.current = t;
  const globalAppearance = useGlobalAppearance();
  const colorScheme = useColorScheme();
  const [state, dispatch] = useReducer(reducer, initialState);

  const cls = (element: string) => resolveClassName(element, props.appearance, globalAppearance);
  const submitting = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const mfaCodeRef = useRef<HTMLInputElement>(null);
  const otpCodeRef = useRef<HTMLInputElement>(null);
  const resetPasswordRef = useRef<HTMLInputElement>(null);
  const resetTokenRef = useRef<string>('');
  const idPrefix = useId();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mfaLockoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mfaCountdown, setMfaCountdown] = React.useState(0);
  const [resendCountdown, setResendCountdown] = React.useState(0);
  const [hasFailedPassword, setHasFailedPassword] = React.useState(false);
  const [progressiveHint, setProgressiveHint] = React.useState(0);
  const [showAllSocial, setShowAllSocial] = React.useState(false);
  const [interstitialCountdown, setInterstitialCountdown] = React.useState(5);
  const recoveryCodeRef = useRef<HTMLInputElement>(null);
  const [slowConnection, setSlowConnection] = React.useState(false);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rememberMeRef = useRef(false);

  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    if (mfaLockoutTimer.current) clearTimeout(mfaLockoutTimer.current);
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
  }, []);

  useEffect(() => {
    if (state.loading) {
      slowTimerRef.current = setTimeout(() => setSlowConnection(true), 5_000);
    } else {
      setSlowConnection(false);
      if (slowTimerRef.current) { clearTimeout(slowTimerRef.current); slowTimerRef.current = null; }
    }
    return () => { if (slowTimerRef.current) clearTimeout(slowTimerRef.current); };
  }, [state.loading]);

  const methods = methodsProp ?? config?.methods ?? ['password'];
  const socialProviders = socialProp ?? config?.socialProviders ?? [];

  useEffect(() => {
    if (auth.isSignedIn && redirectIfAuthenticated && state.step !== 'complete' && typeof window !== 'undefined') {
      if (isSafeRedirectUrl(redirectIfAuthenticated)) window.location.href = redirectIfAuthenticated;
    }
  }, [auth.isSignedIn, redirectIfAuthenticated, state.step]);

  useEffect(() => {
    if (state.step === 'complete') {
      if (showRememberMe && state.email && typeof window !== 'undefined') {
        try { window.localStorage.setItem(`rakomi:${internals.clientId}:last_email`, state.email); } catch { }
      }
      if (afterSignInUrl && typeof window !== 'undefined' && isSafeRedirectUrl(afterSignInUrl)) {
        window.location.href = afterSignInUrl;
      } else {
        onSignIn?.();
      }
    }
  }, [state.step, afterSignInUrl, onSignIn, showRememberMe, state.email, internals.clientId]);

  useEffect(() => {
    if (initialValues?.email) {
      dispatch({ type: 'SET_EMAIL', email: initialValues.email });
    }
  }, [initialValues?.email]);

  const urlInitStarted = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || urlInitStarted.current) return;
    urlInitStarted.current = true;
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    const action = url.searchParams.get('action');

    if (token && token.length > 0 && token.length < 256 && action === 'reset_password') {
      resetTokenRef.current = token;
      dispatch({ type: 'SET_STEP', step: 'reset_password' });
      return;
    }

    if (token && token.length > 0 && token.length < 256 && action === 'magic_link_verify') {
      dispatch({ type: 'SET_LOADING', loading: true });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      void (async () => {
        try {
          const result = await verifyMagicLinkToken({
            baseUrl: internals.baseUrl,
            token,
            apiKey: internals.clientId,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (controller.signal.aborted) return;

          if (result.ok) {
            if ('nextStep' in result && result.nextStep === 'mfa_challenge') {
              dispatch({ type: 'SET_MFA', challengeToken: result.challengeToken, expiresIn: result.expiresIn });
            } else if ('data' in result) {
              await internals.completeSignIn(result.data);
              if (controller.signal.aborted) return;
              url.searchParams.delete('token');
              url.searchParams.delete('action');
              window.history.replaceState(window.history.state, '', url.toString());
              dispatch({ type: 'SET_STEP', step: 'complete' });
            }
          } else {
            dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
          }
        } catch {
          if (!controller.signal.aborted) {
            dispatch({ type: 'SET_ERROR', error: tRef.current('error.unknownError') });
          }
        } finally {
          if (!controller.signal.aborted) {
            dispatch({ type: 'SET_LOADING', loading: false });
          }
        }
      })();
      return () => {
        controller.abort();
        clearTimeout(timeoutId);
      };
    }

    return undefined;
  }, [internals.baseUrl, internals.clientId]);

  useEffect(() => {
    if (state.step !== 'mfa_required' || state.mfaExpiresIn <= 0) return;
    setMfaCountdown(state.mfaExpiresIn);
    const interval = setInterval(() => {
      setMfaCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          dispatch({ type: 'SET_ERROR', error: tRef.current('signIn.mfa.expired') });
          dispatch({ type: 'RESET' });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [state.step, state.mfaExpiresIn]);

  useEffect(() => {
    if (state.mfaAttempts >= 3) {
      if (mfaLockoutTimer.current) clearTimeout(mfaLockoutTimer.current);
      mfaLockoutTimer.current = setTimeout(() => {
        dispatch({ type: 'RESET_MFA_ATTEMPTS' });
        mfaLockoutTimer.current = null;
      }, 30_000);
    }
  }, [state.mfaAttempts]);

  useEffect(() => {
    if (state.resendAfterSeconds <= 0) return;
    setResendCountdown(state.resendAfterSeconds);
    const interval = setInterval(() => {
      setResendCountdown(prev => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [state.resendAfterSeconds, state.step, state.resendSeq]);

  useEffect(() => {
    if (state.step === 'idle' || state.step === 'email_password') {
      emailRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (state.step === 'mfa_required') {
      mfaCodeRef.current?.focus();
    }
  }, [state.step]);

  useEffect(() => {
    if (!showRememberMe || typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(`rakomi:${internals.clientId}:last_email`);
      if (stored && !initialValues?.email) {
        dispatch({ type: 'SET_EMAIL', email: stored });
        passwordRef.current?.focus();
      }
    } catch { }
  }, [showRememberMe, internals.clientId, initialValues?.email]);

  const prevSignedInRef = useRef(auth.isSignedIn);
  useEffect(() => {
    if (!auth.isLoaded) return;
    const prev = prevSignedInRef.current;
    prevSignedInRef.current = auth.isSignedIn;
    if (auth.isSignedIn === false && prev !== false && state.step !== 'idle' && state.step !== 'email_password') {
      resetTokenRef.current = '';
      urlInitStarted.current = false;
      dispatch({ type: 'RESET' });
    }
    if (auth.isSignedIn === true && state.step !== 'complete' && state.step !== 'idle' && !state.loading) {
      dispatch({ type: 'SET_STEP', step: 'complete' });
    }
  }, [auth.isLoaded, auth.isSignedIn]);

  useEffect(() => {
    if (state.step !== 'magic_link_sent' && state.step !== 'email_otp_sent') {
      setProgressiveHint(0);
      return;
    }
    setProgressiveHint(0);
    const t1 = setTimeout(() => setProgressiveHint(1), 15_000);
    const t2 = setTimeout(() => setProgressiveHint(2), 30_000);
    timers.current.push(t1, t2);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [state.step]);

  const stepRef = useRef(state.step);
  stepRef.current = state.step;

  const activeMethodRef = useRef(state.activeMethod);
  activeMethodRef.current = state.activeMethod;

  const interstitialFromPropRef = useRef(false);
  const userHasSwitchedRef = useRef(false);
  const interstitialFocusedRef = useRef(false);

  const initialMethodHandled = useRef(false);
  useEffect(() => {
    if (initialMethodHandled.current || configLoading) return;
    if (userHasSwitchedRef.current) { initialMethodHandled.current = true; return; }
    if (typeof window !== 'undefined') {
      try {
        const url = new URL(window.location.href);
        if ((url.searchParams.has('code') && url.searchParams.has('state')) ||
            sessionStorage.getItem(`rakomi:${internals.clientId}:oauth_state`)) {
          initialMethodHandled.current = true;
          return;
        }
      } catch { }
    }
    const method = initialMethod || (() => {
      if (typeof window === 'undefined') return null;
      try {
        const stored = sessionStorage.getItem(`rakomi:${internals.clientId}:last_method`);
        return stored && (methods.includes(stored) || socialProviders.includes(stored)) ? stored : null;
      } catch { return null; }
    })();
    if (!method) return;
    const fromProp = !!initialMethod;
    interstitialFromPropRef.current = fromProp;
    initialMethodHandled.current = true;
    const isMethod = methods.includes(method);
    const isSocial = socialProviders.includes(method);
    if (!isMethod && !isSocial) {
      if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
        console.warn(`[Rakomi] initialMethod="${method}" does not match any configured method or social provider. Ignoring.`);
      }
      return;
    }
    if (isSocial) {
      dispatch({ type: 'SET_ACTIVE_METHOD', activeMethod: method });
      dispatch({ type: 'SET_STEP', step: 'social_interstitial' });
    } else {
      dispatch({ type: 'SET_ACTIVE_METHOD', activeMethod: method });
    }
    try { sessionStorage.setItem(`rakomi:${internals.clientId}:last_method`, method); } catch { }
  }, [configLoading]);

  useEffect(() => {
    if (state.step !== 'social_interstitial') {
      setInterstitialCountdown(5);
      interstitialFocusedRef.current = false;
      return;
    }
    if (!interstitialFromPropRef.current) return;
    setInterstitialCountdown(5);
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.max(0, 5 - elapsed);
      setInterstitialCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        if (stepRef.current === 'social_interstitial' && activeMethodRef.current) {
          void handleSocialClick(activeMethodRef.current);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [state.step]);

  const emitComponentEvent = (from: string, to: string) => {
    internals.emitEvent({
      type: 'component_step_changed',
      severity: 'info',
      metadata: { component: 'sign_in', from, to },
    });
  };

  const [emailBlurError, setEmailBlurError] = React.useState<string | null>(null);
  const handleEmailBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = e.target.value.trim();
    if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      setEmailBlurError(t('signUp.emailInvalid'));
    } else {
      setEmailBlurError(null);
    }
  };

  if (auth.isSignedIn) {
    return <></>;
  }

  if (!auth.isLoaded || configLoading) {
    if (fallback) return <>{fallback}</>;
    return (
      <div data-rakomi-sign-in-root data-rakomi-card aria-busy="true" className={className} style={style}>
        <div data-rakomi-skeleton>{t('common.loading')}</div>
      </div>
    );
  }

  if (configError && !methodsProp) {
    return (
      <div data-rakomi-sign-in-root data-rakomi-card className={className} style={style}>
        <div aria-live="assertive" data-rakomi-sign-in-error role="alert">
          {t('signIn.configError')}
        </div>
        <button
          type="button"
          data-rakomi-sign-in-retry
          onClick={() => window.location.reload()}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (methods.length === 0 && socialProviders.length === 0) {
    return (
      <div data-rakomi-sign-in-root data-rakomi-card className={className} style={style}>
        <div aria-live="assertive" data-rakomi-sign-in-error role="alert">
          {t('signIn.configError')}
        </div>
      </div>
    );
  }

  const handleEmailPasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const formData = new FormData(e.currentTarget);
    const email = ((formData.get('email') as string | null) ?? '').trim();
    const password = passwordRef.current?.value ?? '';

    dispatch({ type: 'SET_EMAIL', email });

    try {
      if (showRememberMe && rememberMeRef.current) {
        await internals.setPersistence('local');
      }
      internals.emitEvent({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'password' } });
      const result = await auth.signIn({ mode: 'direct', email, password });

      if (result.status === 'complete') {
        emitComponentEvent('email_password', 'complete');
        dispatch({ type: 'SET_STEP', step: 'complete' });
      } else if (result.status === 'mfa_required') {
        emitComponentEvent('email_password', 'mfa_required');
        dispatch({ type: 'SET_MFA', challengeToken: result.challengeToken, expiresIn: result.expiresIn });
      } else if (result.status === 'mfa_setup_required') {
        emitComponentEvent('email_password', 'mfa_setup_required');
        dispatch({ type: 'SET_STEP', step: 'complete' });
      } else if (result.status === 'error') {
        internals.emitEvent({ type: 'sign_in_failed', severity: 'warning', metadata: { method: 'password', errorCode: result.error.code } });
        setHasFailedPassword(true);
        if (result.error.code === 'TENANT_SUSPENDED') {
          dispatch({ type: 'SET_ERROR', error: t('common.tenantSuspended') });
        } else {
          dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
        }
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleMfaVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    if (state.mfaAttempts >= 3) return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const rawCode = state.mfaUseRecovery
      ? (recoveryCodeRef.current?.value ?? '').replace(/[\s-]/g, '').toUpperCase()
      : (mfaCodeRef.current?.value ?? '').trim();
    const code = rawCode;

    try {
      internals.emitEvent({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'mfa_totp' } });
      const result = await verifyMfaLogin({
        baseUrl: internals.baseUrl,
        challengeToken: state.challengeToken,
        code,
      });

      if (result.ok) {
        emitComponentEvent('mfa_required', 'complete');
        await internals.completeSignIn(result.data);
        dispatch({ type: 'SET_STEP', step: 'complete' });
      } else {
        internals.emitEvent({ type: 'sign_in_failed', severity: 'warning', metadata: { method: 'mfa_totp', errorCode: result.error.code } });
        dispatch({ type: 'INCREMENT_MFA_ATTEMPTS' });
        dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleMfaCodeInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\s/g, '');
    if (val.length === 6 && /^[0-9]{6}$/.test(val)) {
      e.target.form?.requestSubmit();
    }
  };

  const handleOtpCodeInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\s/g, '');
    if (val.length === 6 && /^[0-9]{6}$/.test(val)) {
      e.target.form?.requestSubmit();
    }
  };

  const handleSendMagicLink = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const formData = new FormData(e.currentTarget);
    const email = ((formData.get('email') as string | null) ?? '').trim();

    if (!email) {
      dispatch({ type: 'SET_ERROR', error: t('signIn.emailRequired') });
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }

    dispatch({ type: 'SET_EMAIL', email });

    try {
      internals.emitEvent({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'magic_link' } });
      const result = await sendMagicLink({
        baseUrl: internals.baseUrl,
        email,
        apiKey: internals.clientId,
      });

      if (result.ok) {
        emitComponentEvent('idle', 'magic_link_sent');
        dispatch({ type: 'SET_MAGIC_LINK_SENT', resendAfterSeconds: result.resendAfterSeconds });
      } else {
        internals.emitEvent({ type: 'sign_in_failed', severity: 'warning', metadata: { method: 'magic_link', errorCode: result.error.code } });
        dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleSendEmailOtp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const formData = new FormData(e.currentTarget);
    const email = ((formData.get('email') as string | null) ?? '').trim();

    if (!email) {
      dispatch({ type: 'SET_ERROR', error: t('signIn.emailRequired') });
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }

    dispatch({ type: 'SET_EMAIL', email });

    try {
      internals.emitEvent({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'email_otp' } });
      const result = await sendEmailOtp({
        baseUrl: internals.baseUrl,
        email,
        apiKey: internals.clientId,
      });

      if (result.ok) {
        emitComponentEvent('idle', 'email_otp_sent');
        dispatch({ type: 'SET_OTP_SENT', resendAfterSeconds: result.resendAfterSeconds, expiresAt: result.expiresAt });
      } else {
        internals.emitEvent({ type: 'sign_in_failed', severity: 'warning', metadata: { method: 'email_otp', errorCode: result.error.code } });
        dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const code = (otpCodeRef.current?.value ?? '').trim();

    try {
      const result = await verifyEmailOtpCode({
        baseUrl: internals.baseUrl,
        email: state.email,
        code,
        apiKey: internals.clientId,
      });

      if (result.ok) {
        if ('nextStep' in result && result.nextStep === 'mfa_challenge') {
          dispatch({ type: 'SET_MFA', challengeToken: result.challengeToken, expiresIn: result.expiresIn });
        } else if ('data' in result) {
          await internals.completeSignIn(result.data);
          dispatch({ type: 'SET_STEP', step: 'complete' });
        } else {
          dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
        }
      } else {
        dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleSocialClick = async (provider: string) => {
    if (typeof window === 'undefined') return;
    internals.emitEvent({ type: 'sign_in_attempted', severity: 'info', metadata: { method: 'social', provider } });

    try {
      const { codeVerifier, codeChallenge } = await generatePKCE();
      const oauthState = generateState();

      setSessionItem(`rakomi:${internals.clientId}:pkce_verifier`, codeVerifier);
      setSessionItem(`rakomi:${internals.clientId}:oauth_state`, oauthState);

      const url = buildSocialAuthorizeUrl({
        baseUrl: internals.baseUrl,
        provider,
        tenantId: internals.clientId,
        redirectUri: internals.redirectUrl,
        state: oauthState,
        codeChallenge,
        clientId: internals.clientId,
      });

      if (url) {
        dispatch({ type: 'SET_SOCIAL_REDIRECT', provider });
        window.location.href = url;
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    }
  };

  const handleForgotPasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const formData = new FormData(e.currentTarget);
    const email = ((formData.get('email') as string | null) ?? '').trim();

    if (!email) {
      dispatch({ type: 'SET_ERROR', error: t('signIn.emailRequired') });
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }

    try {
      await sendForgotPassword({
        baseUrl: internals.baseUrl,
        email,
        apiKey: internals.clientId,
      });

      dispatch({ type: 'SET_ERROR', error: null });
      dispatch({ type: 'SET_FORGOT_PASSWORD_SUCCESS' });
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleResetPasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    if (typeof window === 'undefined') return;
    submitting.current = true;
    dispatch({ type: 'SET_LOADING', loading: true });

    const newPassword = resetPasswordRef.current?.value ?? '';
    const token = resetTokenRef.current;

    try {
      const result = await submitResetPassword({
        baseUrl: internals.baseUrl,
        token,
        password: newPassword,
        apiKey: internals.clientId,
      });

      if (result.ok) {
        const url = new URL(window.location.href);
        url.searchParams.delete('token');
        url.searchParams.delete('action');
        window.history.replaceState(window.history.state, '', url.toString());
        resetTokenRef.current = '';
        dispatch({ type: 'SET_ERROR', error: null });
        dispatch({ type: 'SET_RESET_PASSWORD_SUCCESS' });
      } else {
        dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('error.unknownError') });
    } finally {
      submitting.current = false;
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  };

  const handleForgotPassword = () => {
    if (forgotPasswordUrl && isSafeRedirectUrl(forgotPasswordUrl) && typeof window !== 'undefined') {
      window.location.href = forgotPasswordUrl;
    } else if (!forgotPasswordUrl) {
      dispatch({ type: 'SET_STEP', step: 'forgot_password' });
    }
  };

  const handleBack = () => {
    dispatch({ type: 'RESET' });
    setHasFailedPassword(false);
  };

  const handleResendMagicLink = async () => {
    if (resendCountdown > 0 || submitting.current) return;
    submitting.current = true;
    try {
      const result = await sendMagicLink({
        baseUrl: internals.baseUrl,
        email: state.email,
        apiKey: internals.clientId,
      });
      if (result.ok) {
        dispatch({ type: 'RESEND_SENT', resendAfterSeconds: result.resendAfterSeconds });
      } else if (result.error.code !== 'NETWORK_ERROR') {
        dispatch({ type: 'SET_ERROR', error: getErrorMessage(result.error) });
      }
    } catch {
    } finally {
      submitting.current = false;
    }
  };

  const renderStep = () => {
    switch (state.step) {
      case 'idle':
      case 'email_password': {
        const showSocial = socialProviders.length > 0;
        const visibleProviders = showAllSocial ? socialProviders : socialProviders.slice(0, 4);
        const hasMoreSocial = socialProviders.length > 4;
        const socialSection = showSocial ? (
          <div role="group" aria-label={t('signIn.socialGroup')} data-rakomi-sign-in-social-grid className={cls('socialGrid') || undefined}>
            {visibleProviders.map(provider => (
              <button
                key={provider}
                type="button"
                data-rakomi-sign-in-social-button
                data-rakomi-social={provider}
                className={cls('socialButton') || undefined}
                aria-label={t('signIn.socialButton', { provider: provider.charAt(0).toUpperCase() + provider.slice(1) })}
                disabled={state.loading}
                onClick={() => { userHasSwitchedRef.current = true; void handleSocialClick(provider); }}
              >
                {t('signIn.socialButton', { provider: provider.charAt(0).toUpperCase() + provider.slice(1) })}
              </button>
            ))}
            {hasMoreSocial && !showAllSocial && (
              <button
                type="button"
                onClick={() => setShowAllSocial(true)}
                aria-expanded={false}
                data-rakomi-sign-in-link
                className={cls('link') || undefined}
              >
                {t('signIn.otherOptions')}
              </button>
            )}
          </div>
        ) : null;

        const formSection = methods.includes('password') && state.activeMethod !== 'magic_link' && state.activeMethod !== 'email_otp' ? (
          <form noValidate onSubmit={(e) => void handleEmailPasswordSubmit(e)} data-rakomi-sign-in-form className={cls('form') || undefined} aria-busy={state.loading}>
            <div data-rakomi-field className={cls('field') || undefined}>
              <label htmlFor={`${idPrefix}-sign-in-email`} className={cls('label') || undefined}>{t('signIn.emailLabel')}</label>
              <input
                ref={emailRef}
                id={`${idPrefix}-sign-in-email`}
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                disabled={state.loading}
                defaultValue={state.email}
                className={cls('input') || undefined}
                onChange={(e) => { dispatch({ type: 'SET_EMAIL', email: e.target.value }); setEmailBlurError(null); }}
                onBlur={handleEmailBlur}
                aria-describedby={emailBlurError ? `${idPrefix}-email-blur-error` : undefined}
                aria-invalid={emailBlurError ? true : undefined}
              />
              {emailBlurError && (
                <div id={`${idPrefix}-email-blur-error`} data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>
                  {emailBlurError}
                </div>
              )}
            </div>

            <PasswordInput
              name="password"
              label={t('signIn.passwordLabel')}
              autoComplete="current-password"
              disabled={state.loading}
              inputRef={passwordRef}
              t={t}
              data-rakomi="sign-in-password"
            />

            {showRememberMe && (
              <div data-rakomi-sign-in-remember-me className={cls('rememberMe') || undefined}>
                <label>
                  <input type="checkbox" name="rememberMe" onChange={(e) => { rememberMeRef.current = e.target.checked; }} />
                  {t('signIn.rememberMe')}
                </label>
              </div>
            )}

            {state.error && (
              <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>
            )}

            <button
              type="submit"
              disabled={state.loading}
              data-rakomi-sign-in-submit-button
              className={cls('submitButton') || undefined}
            >
              {state.loading ? t('common.loading') : t('signIn.submitButton')}
            </button>

            {slowConnection && (
              <p data-rakomi-sign-in-slow-connection aria-live="polite">{t('signIn.slowConnection')}</p>
            )}

            {}
            {hasFailedPassword && (
              <button
                type="button"
                onClick={handleForgotPassword}
                data-rakomi-sign-in-link
                className={cls('link') || undefined}
              >
                {t('signIn.forgotPassword')}
              </button>
            )}
          </form>
        ) : null;

        const showMagicLink = methods.includes('magic_link') && (!methods.includes('password') || state.activeMethod === 'magic_link');
        const showEmailOtp = methods.includes('email_otp') && (!methods.includes('password') || state.activeMethod === 'email_otp');

        const magicLinkForm = showMagicLink ? (
          <form noValidate onSubmit={(e) => void handleSendMagicLink(e)} data-rakomi-sign-in-form className={cls('form') || undefined} aria-busy={state.loading}>
            <div data-rakomi-field className={cls('field') || undefined}>
              <label htmlFor={`${idPrefix}-sign-in-ml-email`} className={cls('label') || undefined}>{t('signIn.emailLabel')}</label>
              <input
                ref={emailRef}
                id={`${idPrefix}-sign-in-ml-email`}
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                disabled={state.loading}
                defaultValue={state.email}
                className={cls('input') || undefined}
              />
            </div>
            {state.error && <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>}
            <button type="submit" disabled={state.loading} data-rakomi-sign-in-submit-button className={cls('submitButton') || undefined}>
              {state.loading ? t('common.loading') : t('signIn.magicLink.send')}
            </button>
          </form>
        ) : null;

        const emailOtpForm = showEmailOtp ? (
          <form noValidate onSubmit={(e) => void handleSendEmailOtp(e)} data-rakomi-sign-in-form className={cls('form') || undefined} aria-busy={state.loading}>
            <div data-rakomi-field className={cls('field') || undefined}>
              <label htmlFor={`${idPrefix}-sign-in-otp-email`} className={cls('label') || undefined}>{t('signIn.emailLabel')}</label>
              <input
                ref={emailRef}
                id={`${idPrefix}-sign-in-otp-email`}
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                disabled={state.loading}
                defaultValue={state.email}
                className={cls('input') || undefined}
              />
            </div>
            {state.error && <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>}
            <button type="submit" disabled={state.loading} data-rakomi-sign-in-submit-button className={cls('submitButton') || undefined}>
              {state.loading ? t('common.loading') : t('signIn.emailOtp.send')}
            </button>
          </form>
        ) : null;

        const alternativeMethods = methods.includes('password') && (methods.includes('magic_link') || methods.includes('email_otp')) ? (
          <div data-rakomi-sign-in-method-switcher className={cls('methodSwitcher') || undefined}>
            {methods.includes('magic_link') && (
              <form noValidate onSubmit={(e) => { userHasSwitchedRef.current = true; void handleSendMagicLink(e); }}>
                <input type="hidden" name="email" value={state.email} />
                <button type="submit" disabled={state.loading || !state.email.trim()} data-rakomi-sign-in-link className={cls('link') || undefined}>
                  {t('signIn.magicLink.send')}
                </button>
              </form>
            )}
            {methods.includes('email_otp') && (
              <form noValidate onSubmit={(e) => { userHasSwitchedRef.current = true; void handleSendEmailOtp(e); }}>
                <input type="hidden" name="email" value={state.email} />
                <button type="submit" disabled={state.loading || !state.email.trim()} data-rakomi-sign-in-link className={cls('link') || undefined}>
                  {t('signIn.emailOtp.send')}
                </button>
              </form>
            )}
          </div>
        ) : null;

        const divider = showSocial && (formSection || magicLinkForm || emailOtpForm) ? (
          <div data-rakomi-divider aria-hidden="true">
            <span>{t('signIn.or')}</span>
          </div>
        ) : null;

        return (
          <>
            {socialPosition === 'top' && socialSection}
            {socialPosition === 'top' && divider}
            {formSection}
            {magicLinkForm}
            {emailOtpForm}
            {alternativeMethods}
            {socialPosition === 'bottom' && divider}
            {socialPosition === 'bottom' && socialSection}
          </>
        );
      }

      case 'mfa_required': {
        const minutes = Math.floor(mfaCountdown / 60);
        const seconds = mfaCountdown % 60;
        return (
          <div data-rakomi-sign-in-mfa-step className={cls('mfaStep') || undefined}>
            <h3>{t('signIn.mfa.title')}</h3>
            {mfaCountdown > 0 && (
              <p data-rakomi-sign-in-mfa-countdown aria-live="polite">
                {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
              </p>
            )}
            <form
              noValidate
              onSubmit={(e) => void handleMfaVerify(e)}
              data-rakomi-sign-in-form
              className={cls('form') || undefined}
              aria-busy={state.loading}
            >
              {state.mfaUseRecovery ? (
                <div data-rakomi-field className={cls('field') || undefined}>
                  <label htmlFor={`${idPrefix}-sign-in-recovery-code`} className={cls('label') || undefined}>{t('signIn.mfa.recoveryCode')}</label>
                  <input
                    ref={recoveryCodeRef}
                    id={`${idPrefix}-sign-in-recovery-code`}
                    name="recoveryCode"
                    type="text"
                    maxLength={9}
                    required
                    disabled={state.loading || state.mfaAttempts >= 3}
                    className={cls('input') || undefined}
                    placeholder="XXXX-XXXX"
                  />
                </div>
              ) : (
                <div data-rakomi-field className={cls('field') || undefined}>
                  <label htmlFor={`${idPrefix}-sign-in-mfa-code`} className={cls('label') || undefined}>{t('signIn.mfa.codeLabel')}</label>
                  <input
                    ref={mfaCodeRef}
                    id={`${idPrefix}-sign-in-mfa-code`}
                    name="mfaCode"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="one-time-code"
                    required
                    disabled={state.loading || state.mfaAttempts >= 3}
                    className={cls('input') || undefined}
                    onChange={handleMfaCodeInput}
                  />
                </div>
              )}

              {state.mfaAttempts >= 3 && (
                <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>
                  {t('signIn.mfa.tooManyAttempts', { seconds: '30' })}
                </div>
              )}

              {state.error && (
                <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>
              )}

              <button type="submit" disabled={state.loading || state.mfaAttempts >= 3} data-rakomi-sign-in-submit-button className={cls('submitButton') || undefined}>
                {state.loading ? t('common.loading') : t('signIn.submitButton')}
              </button>
            </form>

            <button type="button" onClick={() => dispatch({ type: 'TOGGLE_MFA_RECOVERY' })} data-rakomi-sign-in-link className={cls('link') || undefined}>
              {state.mfaUseRecovery ? t('signIn.mfa.codeLabel') : t('signIn.mfa.recoveryCode')}
            </button>

            <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
              {t('signIn.mfa.back')}
            </button>
          </div>
        );
      }

      case 'forgot_password':
        return (
          <div data-rakomi-sign-in-forgot-password-inline className={cls('forgotPasswordInline') || undefined}>
            <h3>{t('signIn.forgotPasswordInline.title')}</h3>
            {state.forgotPasswordSuccess ? (
              <>
                <p role="status" aria-live="polite" data-rakomi-sign-in-success>
                  {t('signIn.forgotPasswordInline.success')}
                </p>
                <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
                  {t('common.back')}
                </button>
              </>
            ) : (
              <>
                <form
                  noValidate
                  onSubmit={(e) => void handleForgotPasswordSubmit(e)}
                  data-rakomi-sign-in-form
                  className={cls('form') || undefined}
                  aria-busy={state.loading}
                >
                  <div data-rakomi-field className={cls('field') || undefined}>
                    <label htmlFor={`${idPrefix}-sign-in-forgot-email`} className={cls('label') || undefined}>{t('signIn.emailLabel')}</label>
                    <input
                      id={`${idPrefix}-sign-in-forgot-email`}
                      name="email"
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      required
                      defaultValue={state.email}
                      className={cls('input') || undefined}
                    />
                  </div>

                  {state.error && <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>}

                  <button type="submit" disabled={state.loading} data-rakomi-sign-in-submit-button className={cls('submitButton') || undefined}>
                    {state.loading ? t('common.loading') : t('signIn.forgotPasswordInline.submit')}
                  </button>
                </form>

                <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
                  {t('common.back')}
                </button>
              </>
            )}
          </div>
        );

      case 'reset_password':
        return (
          <div data-rakomi-sign-in-reset-password>
            <h3>{t('signIn.resetPassword.title')}</h3>
            {state.resetPasswordSuccess ? (
              <>
                <p role="status" aria-live="polite" data-rakomi-sign-in-success>
                  {t('signIn.resetPassword.success')}
                </p>
                <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
                  {t('signIn.title')}
                </button>
              </>
            ) : (
              <>
                <form
                  noValidate
                  onSubmit={(e) => void handleResetPasswordSubmit(e)}
                  data-rakomi-sign-in-form
                  className={cls('form') || undefined}
                  aria-busy={state.loading}
                >
                  <PasswordInput
                    name="newPassword"
                    label={t('userProfile.newPassword')}
                    autoComplete="new-password"
                    disabled={state.loading}
                    inputRef={resetPasswordRef}
                    t={t}
                    data-rakomi="sign-in-reset-password"
                  />

                  {state.error && <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>}

                  <button type="submit" disabled={state.loading} data-rakomi-sign-in-submit-button className={cls('submitButton') || undefined}>
                    {state.loading ? t('common.loading') : t('signIn.resetPassword.submit')}
                  </button>
                </form>

                <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
                  {t('common.back')}
                </button>
              </>
            )}
          </div>
        );

      case 'magic_link_sent':
        return (
          <div data-rakomi-sign-in-magic-link>
            <h3 aria-live="polite">{t('signIn.magicLink.sent')}</h3>
            <p data-rakomi-sign-in-progress-hint className={cls('progressHint') || undefined} aria-live="polite">
              {progressiveHint === 0 && t('signIn.magicLink.sent')}
              {progressiveHint === 1 && t('signIn.magicLink.takingAMoment')}
              {progressiveHint >= 2 && t('signIn.magicLink.checkSpam')}
            </p>
            <button
              type="button"
              onClick={() => void handleResendMagicLink()}
              disabled={resendCountdown > 0}
              data-rakomi-sign-in-link
              className={cls('link') || undefined}
            >
              {resendCountdown > 0
                ? `${t('signIn.magicLink.resend')} (${resendCountdown}s)`
                : t('signIn.magicLink.resend')}
            </button>
            <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
              {t('common.back')}
            </button>
          </div>
        );

      case 'email_otp_sent':
        return (
          <div data-rakomi-sign-in-email-otp>
            <h3 aria-live="polite">{t('signIn.emailOtp.sent', { email: state.email })}</h3>
            <form noValidate onSubmit={(e) => void handleVerifyOtp(e)} data-rakomi-sign-in-form className={cls('form') || undefined} aria-busy={state.loading}>
              <div data-rakomi-field className={cls('field') || undefined}>
                <label htmlFor={`${idPrefix}-sign-in-otp-code`} className={cls('label') || undefined}>{t('signIn.emailOtp.codeLabel')}</label>
                <input
                  ref={otpCodeRef}
                  id={`${idPrefix}-sign-in-otp-code`}
                  name="otpCode"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  className={cls('input') || undefined}
                  onChange={handleOtpCodeInput}
                />
              </div>

              {state.error && <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>{state.error}</div>}

              <button type="submit" disabled={state.loading} data-rakomi-sign-in-submit-button className={cls('submitButton') || undefined}>
                {state.loading ? t('common.loading') : t('signIn.submitButton')}
              </button>
            </form>
            <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
              {t('common.back')}
            </button>
          </div>
        );

      case 'social_interstitial': {
        const providerName = state.activeMethod
          ? state.activeMethod.charAt(0).toUpperCase() + state.activeMethod.slice(1)
          : '';
        const autoCountdown = interstitialFromPropRef.current;
        return (
          <div data-rakomi-sign-in-interstitial>
            {}
            <button
              type="button"
              ref={(el) => { if (el && !interstitialFocusedRef.current) { interstitialFocusedRef.current = true; el.focus(); } }}
              onClick={() => dispatch({ type: 'RESET' })}
              data-rakomi-sign-in-link
              className={cls('link') || undefined}
            >
              {t('signIn.interstitial.cancel')}
            </button>
            <button
              type="button"
              disabled={state.loading}
              data-rakomi-sign-in-submit-button
              className={cls('submitButton') || undefined}
              onClick={() => state.activeMethod && void handleSocialClick(state.activeMethod)}
            >
              {t('signIn.socialButton', { provider: providerName })}
            </button>
            {autoCountdown && (
              <div aria-live="polite" aria-atomic="true" data-rakomi-sign-in-countdown>
                {t('signIn.interstitial.countdown', { provider: providerName, seconds: String(interstitialCountdown) })}
              </div>
            )}
          </div>
        );
      }

      case 'social_redirect':
        return (
          <div data-rakomi-sign-in-redirecting data-rakomi-redirecting="true" aria-live="polite">
            <p>{t('signIn.redirecting', { provider: state.socialProvider.charAt(0).toUpperCase() + state.socialProvider.slice(1) })}</p>
          </div>
        );

      case 'complete':
        return <></>;

      case 'error':
        return (
          <div data-rakomi-sign-in-error-step>
            <div role="alert" data-rakomi-sign-in-error className={cls('errorMessage') || undefined}>
              {state.error ?? t('common.somethingWentWrong')}
            </div>
            <button type="button" onClick={handleBack} data-rakomi-sign-in-link className={cls('link') || undefined}>
              {t('common.retry')}
            </button>
          </div>
        );

      default: {
        const _exhaustive: never = state.step;
        if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) console.warn('[Rakomi] Unhandled step:', _exhaustive);
        return null;
      }
    }
  };

  return (
    <div data-rakomi-sign-in-root data-rakomi-card data-rakomi-theme={colorScheme !== 'auto' ? colorScheme : undefined} data-rakomi-branded={hasBrandingStyles(branding) || undefined} className={[cls('root'), className].filter(Boolean).join(' ') || undefined} style={{ ...applyBranding(branding), ...style }}>
      {logo && isSafeImageSrc(logo.src) ? (
        <img
          src={logo.src}
          alt={logo.alt}
          data-rakomi-sign-in-logo
        />
      ) : branding?.logoUrl && isSafeImageSrc(branding.logoUrl) ? (
        <img
          src={branding.logoUrl}
          alt={branding.tenantName}
          data-rakomi-sign-in-logo
          fetchPriority="low"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ) : null}
      {typeof title === 'string' ? (
        <h2 data-rakomi-sign-in-title className={cls('title') || undefined}>{title}</h2>
      ) : title ? (
        <div data-rakomi-sign-in-title className={cls('title') || undefined}>{title}</div>
      ) : state.step === 'idle' || state.step === 'email_password' || state.step === 'social_interstitial' ? (
        <h2 data-rakomi-sign-in-title className={cls('title') || undefined}>
          {branding?.tenantName ? t('signIn.titleBranded', { name: branding.tenantName }) : t('signIn.title')}
        </h2>
      ) : null}

      {renderStep()}

      {signUpUrl && isSafeRedirectUrl(signUpUrl) && (state.step === 'idle' || state.step === 'email_password' || state.step === 'social_interstitial') && (
        <p data-rakomi-sign-in-link className={cls('link') || undefined}>
          {t('signIn.noAccount', { link: '' })}
          <a href={signUpUrl}>{t('signUp.title')}</a>
        </p>
      )}
    </div>
  );
}

export function SignIn(props: SignInProps): React.ReactElement {
  return (
    <AuthErrorBoundary>
      <SignInInner {...props} />
    </AuthErrorBoundary>
  );
}
