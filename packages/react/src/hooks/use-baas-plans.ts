'use client';

import { useContext, useEffect, useRef, useState } from 'react';

import { RakomiInternalsContext } from '../context.js';
import { sdkFetch } from '../lib/fetch-client.js';

export interface BaasPlanPublicItem {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  interval: 'month' | 'year';
  trial_days: number | null;
  features: string[] | null;
}

export interface UseBaasPlansReturn {
  plans: BaasPlanPublicItem[];
  isLoading: boolean;
  error: string | null;
}

export function useBaasPlans({ tenantSlug }: { tenantSlug: string }): UseBaasPlansReturn {
  const internals = useContext(RakomiInternalsContext);
  const [plans, setPlans] = useState<BaasPlanPublicItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    mountedRef.current = true;

    const fetchPlans = async () => {
      if (!internals) {
        setIsLoading(false);
        setError('useBaasPlans must be called inside <RakomiProvider>');
        return;
      }

      setIsLoading(true);
      try {
        const resp = await sdkFetch(
          `${internals.baseUrl}/v1/billing/baas/${tenantSlug}/public-plans`,
          {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${internals.clientId}` },
          },
        );

        if (!mountedRef.current) return;

        if (resp.status === 404) {
          setPlans([]);
          setError(null);
          return;
        }

        if (!resp.ok) {
          setError(`HTTP ${resp.status}`);
          return;
        }

        const data = (await resp.json()) as { data: BaasPlanPublicItem[] };
        setPlans(data.data ?? []);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : 'Network request failed';
        setError(message);
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    };

    void fetchPlans();

    return () => {
      mountedRef.current = false;
    };
  }, [internals?.baseUrl, internals?.clientId, tenantSlug]);

  return { plans, isLoading, error };
}
