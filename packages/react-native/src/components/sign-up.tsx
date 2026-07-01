/**
 * `<SignUp />` — RN port. Mirrors `<SignIn />`'s
 * UX patterns; password strength scored via `@rakomi/sdk-core/scorePassword`.
 *
 * For 0.1.0 the registration POST is wired against the canonical
 * `/v1/auth/register` endpoint via the injected `HttpClient`. Email-verification
 * follow-up step (which the API returns) leaves the user on the
 * "verification_required" view — the consumer typically renders their own
 * confirmation copy after that.
 */

'use client';

import { type ReactNode,useState } from 'react';

import { type AuthError, isSafeUrl, scorePassword } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';
import { loadRnPrimitives as loadRn } from '../internal/rn-primitives.js';

export interface SignUpProps {
  /** Registration endpoint, default `/v1/auth/register`. */
  registerEndpoint?: string;
  /** Optional return URL after email confirmation — validated via `isSafeUrl`. */
  returnTo?: string;
  style?: any;
}

type Step = { kind: 'form' } | { kind: 'verification_required' } | { kind: 'error'; error: AuthError };

export function SignUp(props: SignUpProps): ReactNode {
  const ctx = useRakomiContext();
  const { View, Text, TextInput, Pressable } = loadRn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'form' });

  const strength = password ? scorePassword(password) : null;
  const returnTo = props.returnTo && isSafeUrl(props.returnTo, ['http', 'https', 'rakomi']) ? props.returnTo : undefined;

  async function onSubmit() {
    if (busy) return;
    setBusy(true);
    ctx.events.push({ type: 'sign_in_attempted', severity: 'info', metadata: { mode: 'register' } });
    try {
      const response = await ctx.http.fetch(props.registerEndpoint ?? '/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password, returnTo }),
      });
      if (!response.ok) {
        setStep({ kind: 'error', error: { code: 'SIGN_IN_FAILED', message: `Register failed (${response.status})` } });
      } else {
        setStep({ kind: 'verification_required' });
      }
    } catch (err) {
      setStep({ kind: 'error', error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : 'network' } });
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'verification_required') {
    return (
      <View style={props.style} accessibilityRole="alert">
        <Text>{ctx.translate('signup.title')}</Text>
        <Text>{ctx.translate('common.continue')}</Text>
      </View>
    );
  }

  return (
    <View style={props.style}>
      <Text accessibilityRole="header">{ctx.translate('signup.title')}</Text>
      <TextInput
        accessibilityLabel={ctx.translate('signup.email')}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
        autoCapitalize="none"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        accessibilityLabel={ctx.translate('signup.password')}
        secureTextEntry
        textContentType="newPassword"
        autoComplete="password-new"
        value={password}
        onChangeText={setPassword}
      />
      {strength ? <Text accessibilityLabel={`Password strength: ${strength}`}>Strength: {strength}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ctx.translate('signup.submit')}
        onPress={onSubmit}
        disabled={busy || !email || !password}
      >
        <Text>{ctx.translate('signup.submit')}</Text>
      </Pressable>
      {step.kind === 'error' ? (
        <Text accessibilityRole="alert">
          {'message' in step.error ? step.error.message : ctx.translate('common.error.unknown')}
        </Text>
      ) : null}
    </View>
  );
}
