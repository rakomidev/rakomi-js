'use client';

/**
 * useLinkedAccounts
 *
 * Wraps the three `/v1/users/me/link*` endpoints for browser consumers. The
 * React SDK has minimal runtime dependencies, so this hook uses
 * plain React state (no React-Query) — consumers who want shared cache can
 * wrap it themselves.
 *
 * SECURITY: always refetches through the verified session token (`useAuth.getToken`).
 * Never trusts URL hints or localStorage for the methods list.
 *
 * REDIRECT FLOW: `link(provider)` POSTs to initiate then navigates same-window
 * (`window.location.assign`). Callers who need popups (mobile, embedded iframes)
 * should drop down to the `@rakomi/node` SDK directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useRakomiInternals } from '../internal/use-auth-internals.js';
import type { AuthError } from '../types.js';
import { useAuth } from './use-auth.js';

export type LinkProvider =
  | 'google'
  | 'github'
  | 'microsoft'
  | 'apple'
  | 'discord'
  | 'facebook'
  | 'slack'
  | 'twitter'
  | 'gitlab'
  | 'linkedin';

export type LinkedVia = 'signup' | 'explicit_link' | 'automatic_link';

export type LinkedMethod =
  | { kind: 'password'; active: boolean }
  | {
      kind: 'social';
      provider: LinkProvider;
      provider_email_hash: string;
      linked_at: string;
      linked_via: LinkedVia;
    }
  | { kind: 'passkey'; count: number };

export interface LinkedMethods {
  methods: LinkedMethod[];
  cooldown_until: string | null;
}

export interface UseLinkedAccountsResult {
  methods: LinkedMethods | undefined;
  isLoading: boolean;
  isLinking: boolean;
  isUnlinking: boolean;
  error: AuthError | null;
  link: (provider: LinkProvider) => Promise<void>;
  unlink: (provider: LinkProvider) => Promise<void>;
  refresh: () => Promise<void>;
}

function makeAuthError(code: string, message: string): AuthError {
  return { code, message } as unknown as AuthError;
}

const TAB_SYNC_TOPIC_BASE = 'rakomi:account:link:mutated';

function tabSyncTopic(userId: string | null | undefined): string {
  return userId ? `${TAB_SYNC_TOPIC_BASE}:${userId}` : TAB_SYNC_TOPIC_BASE;
}

function isSafeAuthorizationUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function useLinkedAccounts(): UseLinkedAccountsResult {
  const auth = useAuth();
  const internals = useRakomiInternals();

  const [methods, setMethods] = useState<LinkedMethods | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isLinking, setIsLinking] = useState<boolean>(false);
  const [isUnlinking, setIsUnlinking] = useState<boolean>(false);
  const [error, setError] = useState<AuthError | null>(null);

  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const getAuthHeader = useCallback(async (): Promise<string | null> => {
    const tok = await auth.getToken();
    if (!tok.ok) {
      setError(tok.error);
      return null;
    }
    return `Bearer ${tok.token}`;
  }, [auth]);

  const doFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<Response | null> => {
      const authHeader = await getAuthHeader();
      if (!authHeader) return null;
      const headers = new Headers(init?.headers);
      headers.set('Authorization', authHeader);
      headers.set('Accept', 'application/json');
      if (init?.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      try {
        return await fetch(`${internals.baseUrl}${path}`, {
          ...init,
          headers,
          redirect: 'error',
        });
      } catch {
        setError(makeAuthError('account_linking/network_error', 'Account linking request failed'));
        return null;
      }
    },
    [internals.baseUrl, getAuthHeader],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    const res = await doFetch('/v1/users/me/link', { method: 'GET' });
    if (!res || !mountedRef.current) {
      if (mountedRef.current) setIsLoading(false);
      return;
    }
    if (res.status === 200) {
      const body = (await res.json()) as LinkedMethods;
      if (mountedRef.current) setMethods(body);
    } else {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (mountedRef.current) {
        setError(
          makeAuthError(body.code ?? `http/${res.status}`, body.message ?? `HTTP ${res.status}`),
        );
      }
    }
    if (mountedRef.current) setIsLoading(false);
  }, [doFetch]);

  const userId = auth.isLoaded && auth.isSignedIn ? auth.userId : null;

  useEffect(() => {
    if (!auth.isLoaded) return;
    if (!auth.isSignedIn) return;
    void refresh();
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(tabSyncTopic(userId));
      channel.onmessage = () => {
        void refresh();
      };
    } catch {
      channel = null;
    }
    return () => {
      if (channel) channel.close();
    };
  }, [auth.isLoaded, auth.isSignedIn, userId, refresh]);

  const broadcastMutation = useCallback(() => {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    try {
      const ch = new BroadcastChannel(tabSyncTopic(userId));
      ch.postMessage({ ts: Date.now() });
      ch.close();
    } catch {
    }
  }, [userId]);

  const link = useCallback(
    async (provider: LinkProvider): Promise<void> => {
      setIsLinking(true);
      setError(null);
      try {
        const redirectUri =
          typeof window !== 'undefined'
            ? `${window.location.origin}${window.location.pathname}`
            : internals.redirectUrl;
        const res = await doFetch(`/v1/users/me/link/${encodeURIComponent(provider)}`, {
          method: 'POST',
          body: JSON.stringify({ redirect_uri: redirectUri }),
          redirect: 'error',
        });
        if (!res) return;
        if (res.status === 200) {
          const body = (await res.json().catch(() => null)) as
            | { authorization_url?: string }
            | null;
          const url = body?.authorization_url;
          if (typeof url !== 'string' || !isSafeAuthorizationUrl(url)) {
            setError(
              makeAuthError(
                'account_linking/invalid_authorization_url',
                'Invalid authorization URL returned by the server.',
              ),
            );
            return;
          }
          broadcastMutation();
          if (typeof window !== 'undefined') {
            window.location.assign(url);
          }
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        setError(
          makeAuthError(body.code ?? `http/${res.status}`, body.message ?? `HTTP ${res.status}`),
        );
      } finally {
        if (mountedRef.current) setIsLinking(false);
      }
    },
    [doFetch, internals.redirectUrl, broadcastMutation],
  );

  const unlink = useCallback(
    async (provider: LinkProvider): Promise<void> => {
      setIsUnlinking(true);
      setError(null);
      try {
        const res = await doFetch(`/v1/users/me/link/${encodeURIComponent(provider)}`, {
          method: 'DELETE',
          redirect: 'error',
        });
        if (!res) return;
        if (res.status === 200) {
          broadcastMutation();
          await refresh();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        setError(
          makeAuthError(body.code ?? `http/${res.status}`, body.message ?? `HTTP ${res.status}`),
        );
      } finally {
        if (mountedRef.current) setIsUnlinking(false);
      }
    },
    [doFetch, refresh, broadcastMutation],
  );

  return { methods, isLoading, isLinking, isUnlinking, error, link, unlink, refresh };
}
