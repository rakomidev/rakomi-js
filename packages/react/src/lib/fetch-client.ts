/**
 * Central fetch client for all React SDK network calls.
 *
 * Security properties enforced on every call (callers cannot override):
 * - credentials: 'omit' — no cookie leakage (GDPR Art. 25)
 * - redirect: 'error'   — no SSRF via open redirect (OWASP API7)
 * - cache: 'no-store'   — auth tokens must never be cached (RFC 9111)
 * - signal               — 10s timeout guaranteed; composes with optional caller signal
 *
 * Callers cannot pass security-critical fields — TypeScript blocks it at compile time.
 */

/** Omit security-critical fields — sdkFetch enforces them; callers cannot override. */
export type SdkFetchInit = Omit<RequestInit, 'credentials' | 'redirect' | 'cache'> & { signal?: AbortSignal };
export type SdkFetchFn = (input: RequestInfo | URL, init?: SdkFetchInit) => Promise<Response>;

export const DEFAULT_SDK_TIMEOUT_MS = 10_000;

export function createFetchClient(defaultTimeoutMs: number): SdkFetchFn {
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new RangeError(
      `createFetchClient: defaultTimeoutMs must be a positive finite number (received: ${defaultTimeoutMs})`
    );
  }
  return function sdkFetch(input, init): Promise<Response> {
    const callerSignal = init?.signal;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(defaultTimeoutMs)])
      : AbortSignal.timeout(defaultTimeoutMs);
    return fetch(input, {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
  };
}

export const sdkFetch: SdkFetchFn = createFetchClient(DEFAULT_SDK_TIMEOUT_MS);

/**
 * Normalize AbortSignal errors into diagnostic messages.
 * TimeoutError = sdkFetch's 10s timeout fired.
 * AbortError = caller cancelled (e.g. component unmount).
 * Industry precedent: ky → TimeoutError class, openai-node → APITimeoutError class.
 *
 * DORA Art. 12: semantic classification of TimeoutError vs AbortError supports
 * ICT-related incident severity classification and mandatory reporting.
 */
export function normalizeNetworkError(err: unknown): string {
  if (err != null && typeof (err as { name?: unknown }).name === 'string') {
    const name = (err as { name: string }).name;
    if (name === 'TimeoutError') return 'Request timed out';
    if (name === 'AbortError') return 'Request cancelled';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Network request failed';
}
