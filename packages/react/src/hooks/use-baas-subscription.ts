'use client';

import { useContext, useEffect, useRef, useState } from 'react';

import { RakomiInternalsContext } from '../context.js';
import { sdkFetch } from '../lib/fetch-client.js';
import { useAuth } from './use-auth.js';

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
  subscription: BaasSubscription | null;
  isLoading: boolean;
  error: string | null;
}

export function useBaasSubscription({ tenantSlug }: { tenantSlug: string }): UseBaasSubscriptionReturn {
  const internals = useContext(RakomiInternalsContext);
  const auth = useAuth();
  const [subscription, setSubscription] = useState<BaasSubscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const getTokenRef = useRef(auth.getToken);
  getTokenRef.current = auth.getToken;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    mountedRef.current = true;

    const fetchSubscription = async () => {
      if (!internals) {
        setIsLoading(false);
        setError('useBaasSubscription must be called inside <RakomiProvider>');
        return;
      }

      setIsLoading(true);
      try {
        const tokenResult = await getTokenRef.current();
        if (!tokenResult.ok) {
          if (mountedRef.current) {
            setSubscription(null);
            setIsLoading(false);
            setError('NOT_SIGNED_IN');
          }
          return;
        }

        const resp = await sdkFetch(
          `${internals.baseUrl}/v1/billing/baas/${tenantSlug}/user/subscription`,
          {
            method: 'GET',
            headers: {
              'X-API-Key': internals.clientId,
              'Authorization': `Bearer ${tokenResult.token}`,
            },
          },
        );

        if (!mountedRef.current) return;

        if (resp.status === 404) {
          setSubscription(null);
          setError(null);
          return;
        }

        if (!resp.ok) {
          setError(`HTTP ${resp.status}`);
          return;
        }

        const data = (await resp.json()) as BaasSubscription;
        setSubscription(data);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Network request failed';
        setError(message);
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    };

    void fetchSubscription();

    return () => {
      mountedRef.current = false;
    };
  }, [internals?.baseUrl, internals?.clientId, tenantSlug]);

  return { subscription, isLoading, error };
}
