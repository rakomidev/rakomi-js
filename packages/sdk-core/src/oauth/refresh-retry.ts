/**
 * Refresh-failure classification and retry timing — platform-neutral.
 *
 * One definition shared by the web and React Native runtimes, so both SDKs agree on which
 * `POST /oauth/token` refresh failures end a session and which only delay it:
 *
 * - **Definitive** (the session is over; clear it, never retry): a 4xx carrying an RFC 6749 §5.2
 *   `error` of `invalid_grant`, `invalid_client`, `invalid_token`, `unauthorized_client` or
 *   `access_denied`, or a bare 401 (client authentication failed).
 * - **Transient** (keep the session, retry with backoff): a 5xx, 429 or 408, a transport failure,
 *   or a response the SDK could not read. A retry re-presents the same refresh token; if the
 *   server had already rotated it, the retry is answered with `invalid_grant`, which is definitive.
 */

/** Base backoff delays between refresh attempts. The budget is one retry per entry. */
export const REFRESH_RETRY_BASE_DELAYS_MS: readonly number[] = [2000, 8000, 30000];

/**
 * Upper bound on a server-supplied `Retry-After` (RFC 9110 §10.2.3). A longer value is honoured
 * up to this cap, so a misconfigured or hostile server cannot park a session indefinitely.
 */
export const MAX_REFRESH_RETRY_AFTER_MS = 120_000;

/** Jitter band applied to each base delay: ±20 %, so clients that failed together do not retry in lockstep. */
const JITTER_FRACTION = 0.2;

const DEFINITIVE_OAUTH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_token',
  'unauthorized_client',
  'access_denied',
]);

/** `true` for an HTTP status that says "try again later": any 5xx, 429 Too Many Requests, 408 Request Timeout. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * `true` when a refresh-grant rejection means the session is over: the server answered with a
 * non-transient 4xx naming the grant or the client as invalid, or a bare 401. A 403 without one
 * of those codes (for example from a proxy in front of the API) is not definitive.
 */
export function isDefinitiveRefreshRejection(status: number, oauthError: string | undefined): boolean {
  if (status < 400 || status >= 500 || isTransientStatus(status)) return false;
  if (oauthError !== undefined && DEFINITIVE_OAUTH_ERRORS.has(oauthError)) return true;
  return status === 401;
}

/** Uniform `[0, 1)` from the platform CSPRNG; `0.5` (no jitter) where none is available. */
function defaultRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (typeof c?.getRandomValues !== 'function') return 0.5;
  const buf = new Uint32Array(1);
  c.getRandomValues(buf);
  return buf[0]! / 0x1_0000_0000;
}

/**
 * Delay before refresh retry number `attempt` (0-based), or `undefined` when the budget is spent.
 *
 * The delay is the jittered base backoff, raised to the server's `Retry-After` when that is longer
 * (capped at {@link MAX_REFRESH_RETRY_AFTER_MS}).
 */
export function refreshRetryDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = defaultRandom,
): number | undefined {
  const base = REFRESH_RETRY_BASE_DELAYS_MS[attempt];
  if (base === undefined) return undefined;
  const jittered = Math.round(base * (1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random()));
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return jittered;
  return Math.max(jittered, Math.min(retryAfterMs, MAX_REFRESH_RETRY_AFTER_MS));
}
