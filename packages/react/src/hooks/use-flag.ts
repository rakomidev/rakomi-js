'use client';

import { useContext, useEffect, useRef, useState } from 'react';

import { RakomiInternalsContext } from '../context.js';
import { sdkFetch } from '../lib/fetch-client.js';

export interface UseFlagUserContext {
  userId?: string;
  userMetadata?: Record<string, unknown>;
}

export interface UseFlagOptions {
  ttl?: number;
  fallback?: unknown;
}

export interface UseFlagReturn<T = unknown> {
  value: T | undefined;
  isLoading: boolean;
  error: string | null;
}

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
  ttl: number;
}

const ETAG_REGEX = /^"[^"]*"$/;

export function useFlag<T = unknown>(
  key: string,
  userContext?: UseFlagUserContext,
  opts?: UseFlagOptions,
): UseFlagReturn<T> {
  const internals = useContext(RakomiInternalsContext);
  const [value, setValue] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const etagRef = useRef<Map<string, string>>(new Map());
  const currentValueRef = useRef<T | undefined>(undefined);

  const effectiveTtl = Math.max(opts?.ttl ?? 60, 10);

  const buildCacheKey = (k: string, ctx?: UseFlagUserContext): string => {
    const userId = ctx?.userId ?? '__anon__';
    return `${k}:${userId}`;
  };

  const evaluate = async (): Promise<void> => {
    if (!internals) {
      setIsLoading(false);
      setError('useFlag must be called inside <RakomiProvider>');
      return;
    }

    const cacheKey = buildCacheKey(key, userContext);
    const cached = cacheRef.current.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.fetchedAt) < cached.ttl * 1000) {
      const cachedValue = cached.value as T;
      if (cachedValue !== currentValueRef.current) {
        setValue(cachedValue);
        currentValueRef.current = cachedValue;
      }
      setIsLoading(false);
      return;
    }

    try {
      const etag = etagRef.current.get(cacheKey);
      const body = {
        ...(userContext?.userId ? { user_id: userContext.userId } : {}),
        ...(userContext?.userMetadata ? { user_metadata: userContext.userMetadata } : {}),
        keys: [key],
      };

      const resp = await sdkFetch(`${internals.baseUrl}/v1/flags/evaluate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${internals.clientId}`,
          'Content-Type': 'application/json',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        body: JSON.stringify(body),
      });

      if (resp.status === 304 && cached) {
        const cachedValue = cached.value as T;
        if (cachedValue !== currentValueRef.current) {
          setValue(cachedValue);
          currentValueRef.current = cachedValue;
        }
        setIsLoading(false);
        return;
      }

      if (!resp.ok) {
        setError(`HTTP ${resp.status}`);
        setIsLoading(false);
        return;
      }

      const data = (await resp.json()) as { flags: Record<string, unknown> };
      const newValue = (data.flags?.[key] ?? opts?.fallback) as T;

      const newEtag = resp.headers.get('etag');
      if (newEtag && ETAG_REGEX.test(newEtag)) {
        etagRef.current.set(cacheKey, newEtag);
      }

      cacheRef.current.set(cacheKey, { value: newValue, fetchedAt: now, ttl: effectiveTtl });

      if (newValue !== currentValueRef.current) {
        setValue(newValue);
        currentValueRef.current = newValue;
      }
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network request failed';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    void evaluate();

    const intervalId = setInterval(() => {
      void evaluate();
    }, effectiveTtl * 1000);

    return () => clearInterval(intervalId);
  }, [key, userContext?.userId, internals?.clientId]);

  return { value, isLoading, error };
}
