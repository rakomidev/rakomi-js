'use client';

/**
 * Cloudflare Turnstile widget for the prebuilt components, rendered only when `GET /v1/auth/config`
 * says the environment requires a bot challenge (`AuthConfig.botChallenge`). The script is loaded
 * on first need, from `challenges.cloudflare.com` only, and never when no challenge is required.
 *
 * A page with a Content Security Policy must allow `https://challenges.cloudflare.com` in
 * `script-src` and `frame-src`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { BotChallengeAction } from '@rakomi/sdk-core';

interface TurnstileApi {
  render: (
    container: HTMLElement,
    params: {
      sitekey: string;
      action?: string;
      theme?: 'light' | 'dark' | 'auto';
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    },
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

/** The only origin the script is ever loaded from. */
export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<TurnstileApi> | null = null;

function turnstileOf(w: Window): TurnstileApi | undefined {
  return (w as Window & { turnstile?: TurnstileApi }).turnstile;
}

/** Loads the Turnstile script once per page; resolves when `window.turnstile` is usable. */
export function loadTurnstile(): Promise<TurnstileApi> {
  const ready = turnstileOf(window);
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.addEventListener('load', () => {
      const api = turnstileOf(window);
      if (api) resolve(api);
      else reject(new Error('Turnstile did not initialise'));
    });
    script.addEventListener('error', () => reject(new Error('Turnstile script failed to load')));
    document.head.appendChild(script);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

export interface BotChallenge {
  /** The environment requires a token for this action. */
  required: boolean;
  /** The current single-use token, or null while there is none. */
  token: string | null;
  /** The widget to render inside the form (null when not required). */
  widget: React.ReactElement | null;
  /** Discards the current token and asks the widget for a new one (call after every submit). */
  reset: () => void;
}

/**
 * Widget state for one form. `siteKey` undefined: no challenge, nothing is loaded or rendered.
 */
export function useBotChallenge(siteKey: string | undefined, action: BotChallengeAction): BotChallenge {
  const [token, setToken] = useState<string | null>(null);
  const resetRef = useRef<(() => void) | null>(null);

  const reset = useCallback(() => {
    setToken(null);
    resetRef.current?.();
  }, []);

  const widget = siteKey ? (
    <TurnstileWidget siteKey={siteKey} action={action} onToken={setToken} resetRef={resetRef} />
  ) : null;

  return { required: Boolean(siteKey), token: siteKey ? token : null, widget, reset };
}

function TurnstileWidget({ siteKey, action, onToken, resetRef }: {
  siteKey: string;
  action: BotChallengeAction;
  /** A state setter (stable identity). */
  onToken: (token: string | null) => void;
  resetRef: React.MutableRefObject<(() => void) | null>;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | undefined;
    let api: TurnstileApi | undefined;

    loadTurnstile().then((loaded) => {
      if (cancelled || !containerRef.current) return;
      api = loaded;
      widgetId = loaded.render(containerRef.current, {
        sitekey: siteKey,
        action,
        theme: 'auto',
        callback: (t) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
      resetRef.current = () => { if (api && widgetId) api.reset(widgetId); };
    }).catch(() => {
      if (!cancelled) onToken(null);
    });

    return () => {
      cancelled = true;
      resetRef.current = null;
      onToken(null);
      if (api && widgetId) api.remove(widgetId);
    };
  }, [siteKey, action, resetRef, onToken]);

  return <div ref={containerRef} data-rakomi-bot-challenge />;
}
