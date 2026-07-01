/**
 * Default `HttpClient` for React Native — wraps WHATWG `fetch` with the
 * SSRF guard required by the project security rules (`redirect: 'error'`).
 *
 * used by all OAuth/PKCE/refresh flows. Consumers can inject a
 * custom `HttpClient` via `nativeAdapter` for telemetry / mTLS / retry layers.
 */

import type { HttpClient, HttpClientInit } from '@rakomi/sdk-core';

export interface CreateRnHttpClientOptions {
  /** Base URL prepended to relative paths (e.g. `https://api.rakomi.com`). */
  baseUrl?: string;
  /** Default request timeout in ms. Default: 30_000. */
  defaultTimeoutMs?: number;
}

export function createRnHttpClient(options: CreateRnHttpClientOptions = {}): HttpClient {
  const baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
  const timeout = options.defaultTimeoutMs ?? 30_000;
  return {
    fetch: async (url: string, init: HttpClientInit = {}) => {
      const fullUrl = url.startsWith('http://') || url.startsWith('https://') ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        return await fetch(fullUrl, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          redirect: 'error',
          signal: init.signal ?? controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
