/**
 * Default `HttpClient` for React Native — wraps WHATWG `fetch` with the
 * SSRF guard required by the project security rules (`redirect: 'error'`).
 *
 * used by all OAuth/PKCE/refresh flows. Consumers can inject a
 * custom `HttpClient` via `nativeAdapter` for telemetry / mTLS / retry layers.
 */

import type { HttpClient, HttpClientInit } from '@rakomi/sdk-core';

import { composeSignals } from './compose-signals.js';

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
      const timedOut = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
      const timer = setTimeout(() => controller.abort(timedOut), timeout);
      const composed = composeSignals(init.signal, controller.signal);
      let response: Response;
      try {
        response = await fetch(fullUrl, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          redirect: 'error',
          signal: composed.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        composed.dispose();
        throw err;
      }

      clearTimeout(timer);

      const body: unknown = (response as { body?: unknown }).body;
      const streaming =
        body !== null &&
        body !== undefined &&
        typeof (body as ReadableStream<Uint8Array>).pipeThrough === 'function' &&
        typeof TransformStream !== 'undefined';

      if (!streaming) {
        composed.dispose();
        return response;
      }

      const release = new TransformStream<Uint8Array, Uint8Array>({
        flush: () => composed.dispose(),
      });
      const piped = (body as ReadableStream<Uint8Array>).pipeThrough(release);
      const wrapped = new Response(piped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      composed.signal.addEventListener('abort', () => composed.dispose(), { once: true });
      return wrapped;
    },
  };
}
