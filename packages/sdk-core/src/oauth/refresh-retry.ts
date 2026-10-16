/**
 * Refresh-failure classification and retry timing — platform-neutral.
 *
 * One definition shared by the web and React Native runtimes, so both SDKs agree on which
 * `POST /oauth/token` refresh failures end a session and which only delay it:
 *
 * - **Definitive** (the session is over; clear it, never retry): a 4xx carrying an RFC 6749 §5.2
 *   `error` of `invalid_grant`, `invalid_client`, `invalid_token`, `unauthorized_client` or
 *   `access_denied`, or a bare 401 (client authentication failed). Also a 2xx whose body the SDK
 *   cannot read: the server already rotated the refresh token, and presenting it again would be a
 *   reuse that revokes every session of the user.
 * - **Retry once, now** ({@link isRefreshRetryOnceStatus}): a 5xx other than 503 and 521–523, or a
 *   transport failure (no response arrived). The server may have rotated the refresh token before
 *   it failed or before its answer was lost, and it hands a lost rotation back
 *   only to an identical retry (same client, same network address and user agent, same DPoP key)
 *   within 10 seconds of the rotation. So the refresh is sent once more, immediately, and only
 *   while the first answer arrived within {@link REFRESH_RETRY_ONCE_DEADLINE_MS}. If that retry is
 *   not a success or a definitive rejection, the outcome of the first request is unknown: the
 *   session ends locally and the user signs in again. The token is never presented later — after
 *   the window, a rotated token presented again revokes every session of the user.
 *   {@link refreshWithOneImmediateRetry} implements this for every runtime.
 * - **Transient** (keep the session, retry with backoff): a 503, 521, 522 or 523 (the request did not
 *   reach a server that could rotate the token), or a 429 or 408 (whatever the body). A retry
 *   re-presents the same refresh token; the server did not accept it, so it is still valid.
 */

import type { AuthError } from '../types/auth-error.js';

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

/**
 * `true` for a refresh failure status after which the server may already have rotated the
 * refresh token: any 5xx except 503 (Service Unavailable) and 521–523 (the origin was down,
 * timed out on connect, or unreachable — the request never reached it).
 */
export function isRefreshRetryOnceStatus(status: number): boolean {
  if (status < 500 || status > 599) return false;
  return status !== 503 && !(status >= 521 && status <= 523);
}

/**
 * How long after sending the first refresh its 5xx answer may arrive for the SDK still to retry.
 * The server keeps a lost rotation for 10 seconds; the margin covers the retry's own trip.
 */
export const REFRESH_RETRY_ONCE_DEADLINE_MS = 8000;

/**
 * What made the first refresh worth one immediate retry: the HTTP status of a
 * {@link isRefreshRetryOnceStatus} answer, or `'network'` when no response arrived.
 */
export type RefreshRetryOnceTrigger = number | 'network';

/** Outcome of {@link refreshWithOneImmediateRetry}. */
export interface RefreshRetryOnceOutcome<R> {
  /** The result to act on: the retry's result when one was sent, else the first. */
  result: R;
  /**
   * Set when the refresh outcome is unknown: the first request failed this way and no retry settled
   * it. End the session and sign in again; never present the refresh token again.
   */
  uncertainAfter?: RefreshRetryOnceTrigger;
  /** `true` when a second request was sent. */
  retried: boolean;
}

/**
 * Send a refresh, and after a {@link isRefreshRetryOnceStatus} failure or a transport failure send it
 * once more, immediately — never later and never a third time.
 *
 * `send` performs one complete refresh attempt (including a DPoP proof with a fresh `jti` from the
 * same key, and any nonce retry). `retryOnceTrigger` returns the {@link RefreshRetryOnceTrigger} when a
 * result is a retry-once failure, else `undefined`. The retry is sent only while the first failure
 * arrived within {@link REFRESH_RETRY_ONCE_DEADLINE_MS}. `isSettled` says whether a result is final: a success or a
 * definitive rejection (for example `invalid_grant`). Anything else after the retry — another 5xx, a
 * 503, a 429, a transport failure — leaves the outcome unknown.
 */
export async function refreshWithOneImmediateRetry<R>(input: {
  send: () => Promise<R>;
  retryOnceTrigger: (result: R) => RefreshRetryOnceTrigger | undefined;
  isSettled: (result: R) => boolean;
  now?: () => number;
}): Promise<RefreshRetryOnceOutcome<R>> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const first = await input.send();
  const trigger = input.retryOnceTrigger(first);
  if (trigger === undefined) return { result: first, retried: false };
  if (now() - startedAt > REFRESH_RETRY_ONCE_DEADLINE_MS) {
    return { result: first, uncertainAfter: trigger, retried: false };
  }
  const second = await input.send();
  if (input.isSettled(second)) return { result: second, retried: true };
  return { result: second, uncertainAfter: trigger, retried: true };
}

/**
 * {@link refreshWithOneImmediateRetry} classifiers for a refresh result shaped
 * `{ ok: true, … } | { ok: false, error: AuthError }`: the retry-once trigger of a failed result — a
 * {@link isRefreshRetryOnceStatus} status, or `'network'` for a transport failure (a `'network'`
 * refresh failure without a status).
 */
export function refreshRetryOnceTriggerOf(result: { ok: boolean; error?: AuthError }): RefreshRetryOnceTrigger | undefined {
  const error = result.ok ? undefined : result.error;
  if (error?.code !== 'REFRESH_FAILED' || error.reason !== 'network') return undefined;
  if (error.status === undefined) return 'network';
  return isRefreshRetryOnceStatus(error.status) ? error.status : undefined;
}

/** A refresh result that needs no retry: a success, or a rejection that ends the session. */
export function isSettledRefreshResult(result: { ok: boolean; error?: AuthError }): boolean {
  if (result.ok) return true;
  const error = result.error;
  return error?.code === 'REFRESH_FAILED' && (error.reason === 'revoked' || error.reason === 'expired');
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
