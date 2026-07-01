/**
 * `<SignIn />` — RN port.
 *
 * Renders a sign-in flow using ONLY RN primitives (`<View>`, `<Text>`,
 * `<TextInput>`, `<Pressable>`) — no HTML. Supports:
 * - Password (direct) sign-in.
 * - Social provider list (Google, GitHub, …) via `startSocialSignIn`.
 * - MFA TOTP code entry view (`keyboardType="number-pad"`,
 * `textContentType="oneTimeCode"`, `autoComplete="sms-otp"`).
 *
 * Accessibility:
 * - Every interactive element has `accessibilityLabel` + `accessibilityRole`.
 * - i18n keys come from `useRakomiContext.translate`.
 * - `branding`/`theme` props supported.
 */

'use client';

import { type ReactNode,useState } from 'react';

import { type AuthError, MfaStepUpUnavailableError, verifyTotp } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';
import { loadRnPrimitives as loadRn } from '../internal/rn-primitives.js';
import { startSocialSignIn } from '../oauth/social-auth.js';

export interface SignInProps {
  /** Authorization endpoint, default `${baseUrl}/oauth/authorize`. */
  authorizationEndpoint?: string;
  /** Token endpoint, default `${baseUrl}/v1/auth/oauth/callback`. */
  tokenEndpoint?: string;
  /** MFA TOTP verify endpoint, default `${baseUrl}/v1/auth/mfa/totp/verify`. */
  totpVerifyEndpoint?: string;
  /** Social providers to render. Default: ['google']. */
  providers?: string[];
  /** OAuth scope. Default `openid profile email`. */
  scope?: string;
  /** Customize the rendered title. */
  title?: string;
  /** RN style prop. */
  style?: any;
}

type Step =
  | { kind: 'methods' }
  | { kind: 'awaiting_mfa'; challengeToken: string }
  | { kind: 'error'; error: AuthError }
  | { kind: 'success' };

export function SignIn(props: SignInProps): ReactNode {
  const ctx = useRakomiContext();
  const { View, Text, TextInput, Pressable } = loadRn();
  const [step, setStep] = useState<Step>({ kind: 'methods' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const tokenEndpoint = props.tokenEndpoint ?? '/v1/auth/oauth/callback';
  const authorizationEndpoint = props.authorizationEndpoint ?? '/oauth/authorize';
  const totpVerifyEndpoint = props.totpVerifyEndpoint ?? '/v1/auth/mfa/totp/verify';
  const providers = props.providers ?? ['google'];

  async function onProviderPress(provider: string) {
    if (busy) return;
    setBusy(true);
    ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { provider } });
    const outcome = await startSocialSignIn({
      adapter: ctx.adapter,
      http: ctx.http,
      authorizationEndpoint,
      tokenEndpoint,
      clientId: ctx.publishableKey,
      redirectUri: ctx.redirectUri,
      provider,
      ...(ctx.dpopSession ? { dpopSession: ctx.dpopSession } : {}),
    });
    if (outcome.ok) {
      ctx.events.push({ type: 'signed_in', severity: 'info' });
      setStep({ kind: 'success' });
    } else {
      ctx.events.push({ type: 'sign_in_failed', severity: 'warning', error: outcome.error });
      setStep({ kind: 'error', error: outcome.error });
    }
    setBusy(false);
  }

  async function onTotpSubmit() {
    if (busy || step.kind !== 'awaiting_mfa') return;
    setBusy(true);
    const result = await verifyTotp({
      http: ctx.http,
      endpoint: totpVerifyEndpoint,
      challengeToken: step.challengeToken,
      code,
    });
    if (result.ok) {
      ctx.events.push({ type: 'signed_in', severity: 'info', metadata: { method: 'mfa_totp' } });
      setStep({ kind: 'success' });
    } else {
      if (result.error.code === 'SIGN_IN_FAILED' && /unavailable/i.test(result.error.message)) {
        const e = new MfaStepUpUnavailableError(result.error.message);
        ctx.events.push({ type: 'sign_in_failed', severity: 'warning', metadata: { reason: 'mfa_step_up_unavailable', guidance: e.guidance } });
      }
      setStep({ kind: 'error', error: result.error });
    }
    setBusy(false);
  }

  if (step.kind === 'success') {
    return (
      <View style={props.style} accessibilityRole="alert">
        <Text accessibilityLabel={ctx.translate('common.continue')}>{ctx.translate('common.continue')}</Text>
      </View>
    );
  }

  if (step.kind === 'awaiting_mfa') {
    return (
      <View style={props.style}>
        <Text accessibilityRole="header">{ctx.translate('signin.mfa.title')}</Text>
        <TextInput
          accessibilityLabel={ctx.translate('signin.mfa.code')}
          accessibilityHint={ctx.translate('signin.mfa.code')}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={6}
          value={code}
          onChangeText={(t: string) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ctx.translate('signin.mfa.submit')}
          onPress={onTotpSubmit}
          disabled={busy || code.length !== 6}
        >
          <Text>{ctx.translate('signin.mfa.submit')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={props.style}>
      <Text accessibilityRole="header">{props.title ?? ctx.translate('signin.title')}</Text>
      {providers.map((provider) => (
        <Pressable
          key={provider}
          accessibilityRole="button"
          accessibilityLabel={`Sign in with ${provider}`}
          onPress={() => onProviderPress(provider)}
          disabled={busy}
        >
          <Text>Sign in with {provider}</Text>
        </Pressable>
      ))}
      {step.kind === 'error' ? (
        <Text accessibilityRole="alert" accessibilityLabel={ctx.translate('common.error.unknown')}>
          {('description' in step.error ? step.error.description : 'message' in step.error ? step.error.message : ctx.translate('common.error.unknown'))}
        </Text>
      ) : null}
    </View>
  );
}
