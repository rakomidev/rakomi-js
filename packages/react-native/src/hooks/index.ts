/**
 * Hook surface — parity superset of `@rakomi/react`.
 *
 * 0.1.0 ships these as thin reads off `RakomiContextValue` + minimal stubs that
 * preserve the `@rakomi/react` return-shape so the parity test (`test/parity.test.ts`)
 * passes. Full data wiring (Org list, Linked accounts, Flag eval, Branding, BaaS
 * plans/subscriptions) lands in a future release; the public types are LOCKED.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';

import type { AuthConfig, BrandingConfig, OrgContext, OrgMembership, TranslationFn } from '@rakomi/sdk-core';

import { useRakomiContext } from '../context.js';

export type { AuthState } from './use-auth.js';
export { useAuth } from './use-auth.js';
export type { UseSessionReturn } from './use-session.js';
export { useSession } from './use-session.js';
export type { UseUserReturn } from './use-user.js';
export { useUser } from './use-user.js';

export interface UseFlagOptions {
  /** Optional default value if the flag is unknown. */
  defaultValue?: boolean | string | number;
  /** Optional user context override (rarely needed — provider supplies it). */
  user?: { id?: string; email?: string };
}

export interface UseFlagReturn<T = unknown> {
  isLoaded: boolean;
  value: T | undefined;
  isEnabled: boolean;
}

export function useFlag<T = unknown>(flag: string, options?: UseFlagOptions): UseFlagReturn<T> {
  const { user } = useRakomiContext();
  const flags = (user?.rawClaims['feature_flags'] as Record<string, unknown> | undefined) ?? {};
  const value = (flags[flag] ?? options?.defaultValue) as T | undefined;
  return {
    isLoaded: !!user,
    value,
    isEnabled: value === true,
  };
}

export interface UseOrganizationReturn {
  isLoaded: boolean;
  organization: OrgContext | null;
}

export function useOrganization(): UseOrganizationReturn {
  const { user } = useRakomiContext();
  const orgId = user?.rawClaims['org_id'] as string | undefined;
  const orgRole = user?.rawClaims['org_role'] as string | undefined;
  const orgMemberships = (user?.rawClaims['org_memberships'] as OrgMembership[] | undefined) ?? [];
  return {
    isLoaded: !!user,
    organization: orgId && orgRole ? { orgId, orgRole, orgMemberships } : null,
  };
}

export interface UseOrganizationListReturn {
  isLoaded: boolean;
  organizations: OrgMembership[];
}

export function useOrganizationList(): UseOrganizationListReturn {
  const { user } = useRakomiContext();
  return {
    isLoaded: !!user,
    organizations: (user?.rawClaims['org_memberships'] as OrgMembership[] | undefined) ?? [],
  };
}

export type LinkProvider = 'google' | 'github' | 'microsoft' | 'apple' | 'discord' | 'facebook' | 'slack' | 'twitter' | 'gitlab' | 'linkedin';
export type LinkedVia = 'oauth' | 'password' | 'magic_link' | 'email_otp' | 'passkey' | 'anonymous';
export interface LinkedMethod {
  provider: LinkProvider | 'password' | 'magic_link' | 'email_otp' | 'passkey';
  via: LinkedVia;
  linkedAt: string;
}
export type LinkedMethods = LinkedMethod[];
export interface UseLinkedAccountsResult {
  isLoaded: boolean;
  methods: LinkedMethods;
  link: (provider: LinkProvider) => Promise<{ status: 'redirect' | 'error' }>;
  unlink: (provider: LinkProvider | 'password' | 'magic_link' | 'email_otp' | 'passkey') => Promise<{ status: 'complete' | 'error' }>;
}

export function useLinkedAccounts(): UseLinkedAccountsResult {
  const { user } = useRakomiContext();
  const methods = (user?.rawClaims['linked_methods'] as LinkedMethods | undefined) ?? [];
  return {
    isLoaded: !!user,
    methods,
    link: async () => ({ status: 'error' }),
    unlink: async () => ({ status: 'error' }),
  };
}

export function useTranslation(): { t: TranslationFn; locale: string } {
  const { translate, locale } = useRakomiContext();
  return useMemo(() => ({ t: translate, locale }), [translate, locale]);
}

export interface UseAuthConfigReturn {
  isLoaded: boolean;
  config: AuthConfig | null;
}

/**
 * Fetches `<baseUrl>/v1/auth/config` once per provider lifetime. Result is cached
 * across hook instances via the simple module-level memo below — multiple consumers
 * mounting `useAuthConfig` will share a single in-flight request.
 */
const authConfigCache = new Map<string, Promise<AuthConfig | null>>();

export function useAuthConfig(): UseAuthConfigReturn {
  const { baseUrl, http, publishableKey } = useRakomiContext();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (!baseUrl) return;
    const cacheKey = `${baseUrl}|${publishableKey}`;
    let cached = authConfigCache.get(cacheKey);
    if (!cached) {
      cached = (async () => {
        try {
          const response = await http.fetch(`${baseUrl}/v1/auth/config`, {
            method: 'GET',
            headers: { Accept: 'application/json', 'X-API-Key': publishableKey },
          });
          if (!response.ok) return null;
          return (await response.json()) as AuthConfig;
        } catch {
          return null;
        }
      })();
      authConfigCache.set(cacheKey, cached);
    }
    let cancelled = false;
    void cached.then((value) => {
      if (!cancelled) {
        setConfig(value);
        setIsLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, http, publishableKey]);

  return { isLoaded, config };
}

export interface UseBrandingReturn {
  isLoaded: boolean;
  branding: BrandingConfig | null;
}

export function useBranding(): UseBrandingReturn {
  const { config, isLoaded } = useAuthConfig();
  return {
    isLoaded,
    branding: config?.branding ?? null,
  };
}

export interface UseAnonymousSigninResult {
  isLoaded: boolean;
  signInAnonymously: (options?: { publicMetadata?: Record<string, unknown> }) => Promise<{ status: 'complete' | 'error' }>;
}

export function useAnonymousSignin(): UseAnonymousSigninResult {
  return {
    isLoaded: true,
    signInAnonymously: async () => ({ status: 'error' }),
  };
}

export interface BaasPlanPublicItem {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  interval: string;
  trial_days: number | null;
  features: string[] | null;
}

export interface UseBaasPlansReturn {
  isLoaded: boolean;
  plans: BaasPlanPublicItem[];
  error: string | null;
}

const baasPlansCache = new Map<string, Promise<BaasPlanPublicItem[] | { error: string }>>();

/**
 * Fetch the public BaaS plan list for `tenantSlug` from `/v1/billing/baas/{slug}/public-plans`.
 * Response is cached per `(baseUrl, tenantSlug)` for the provider lifetime.
 */
export function useBaasPlans({ tenantSlug }: { tenantSlug: string }): UseBaasPlansReturn {
  const { baseUrl, http, publishableKey } = useRakomiContext();
  const [plans, setPlans] = useState<BaasPlanPublicItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseUrl || !tenantSlug) return;
    const cacheKey = `${baseUrl}|${tenantSlug}`;
    let cached = baasPlansCache.get(cacheKey);
    if (!cached) {
      cached = (async () => {
        try {
          const response = await http.fetch(`${baseUrl}/v1/billing/baas/${encodeURIComponent(tenantSlug)}/public-plans`, {
            method: 'GET',
            headers: { Accept: 'application/json', 'X-API-Key': publishableKey },
          });
          if (response.status === 404) return [] as BaasPlanPublicItem[];
          if (!response.ok) return { error: `HTTP ${response.status}` };
          const json = (await response.json()) as { data: BaasPlanPublicItem[] };
          return json.data ?? [];
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Network request failed' };
        }
      })();
      baasPlansCache.set(cacheKey, cached);
    }
    let cancelled = false;
    void cached.then((value) => {
      if (cancelled) return;
      if (Array.isArray(value)) {
        setPlans(value);
        setError(null);
      } else {
        setError(value.error);
      }
      setIsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, http, publishableKey, tenantSlug]);

  return { isLoaded, plans, error };
}

export interface BaasSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UseBaasSubscriptionReturn {
  isLoaded: boolean;
  subscription: BaasSubscription | null;
  error: string | null;
}

/**
 * Fetch the signed-in user's BaaS subscription for `tenantSlug`. Authenticated:
 * sends `Authorization: Bearer <accessToken>` from `getToken()`.
 *
 * 404 (no subscription) → `subscription: null` + `isLoaded: true` (NOT an error).
 */
export function useBaasSubscription({ tenantSlug }: { tenantSlug: string }): UseBaasSubscriptionReturn {
  const { baseUrl, http, publishableKey, getToken } = useRakomiContext();
  const [subscription, setSubscription] = useState<BaasSubscription | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!baseUrl || !tenantSlug) return;
    let cancelled = false;
    void (async () => {
      try {
        const tokenResult = await getToken();
        const headers: Record<string, string> = { Accept: 'application/json', 'X-API-Key': publishableKey };
        if (tokenResult.ok) headers['Authorization'] = `Bearer ${tokenResult.token}`;
        const response = await http.fetch(`${baseUrl}/v1/billing/baas/${encodeURIComponent(tenantSlug)}/user/subscription`, {
          method: 'GET',
          headers,
        });
        if (cancelled) return;
        if (response.status === 404) {
          setSubscription(null);
          setError(null);
        } else if (response.ok) {
          const json = (await response.json()) as BaasSubscription;
          setSubscription(json);
          setError(null);
        } else {
          setError(`HTTP ${response.status}`);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Network request failed');
      } finally {
        if (!cancelled) setIsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, http, publishableKey, tenantSlug, getToken]);

  return { isLoaded, subscription, error };
}
