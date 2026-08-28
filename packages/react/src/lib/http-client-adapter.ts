'use client';

/**
 * The `HttpClient` `@rakomi/sdk-core` is injected with, for browser consumers.
 *
 * It is deliberately boring: it delegates straight to `sdkFetch`, so the security posture every
 * React SDK request already has — `redirect: 'error'` (the `HttpClient` contract requires it),
 * `credentials: 'omit'`, `cache: 'no-store'`, and the 10 s timeout — stays defined in exactly one
 * file. Re-implementing headers or error handling here would fork that posture; the passkey HTTP
 * semantics (which header goes on which leg, no retry on a finish call, how a 401 is read) live in
 * `@rakomi/sdk-core` and must not be duplicated either.
 *
 * The 10 s budget applies **per HTTP leg**. The 60 s ceremony budget that governs the authenticator
 * interaction runs *between* the legs — the two never race each other.
 *
 * Mirrors `@rakomi/react-native`'s `createRnHttpClient`: same contract, same shape, one pattern.
 */

import type { HttpClient, HttpClientInit } from '@rakomi/sdk-core';

import { sdkFetch } from './fetch-client.js';

export function createSdkHttpClient(): HttpClient {
  return {
    fetch: (url: string, init: HttpClientInit = {}): Promise<Response> =>
      sdkFetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      }),
  };
}
