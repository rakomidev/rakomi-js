
/**
 * `true` for a refresh failure status after which the server may already have rotated the
 * refresh token: any 5xx except 503 and 521–523 (the request never reached a server that could).
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

/** What made the first refresh worth one immediate retry: a retry-once HTTP status, or `'network'` (no response). */
export type RefreshRetryOnceTrigger = number | 'network';

export interface RefreshRetryOnceOutcome<R> {
  result: R;
  /** Set when the outcome is unknown: the first request failed this way and no retry settled it. */
  uncertainAfter?: RefreshRetryOnceTrigger;
  retried: boolean;
}

/**
 * Send a refresh, and after a retry-once failure send it once more, immediately — never later and
 * never a third time. Anything after the retry that is not settled leaves the outcome unknown.
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
