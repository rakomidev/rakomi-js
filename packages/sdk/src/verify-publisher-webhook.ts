import { WEBHOOK_INVALID_SECRET } from './errors.js';
import type {
  PublisherWebhookEvent,
  PublisherWebhookEventType,
  PublisherWebhookVerifyData,
  VerifyResult,
} from './types.js';
import { getHeader, verifyWebhook } from './verify-webhook.js';

const RKSEC_PREFIX = 'rksec_';
const PUBLISHER_DEFAULT_TOLERANCE = 300;
const MAX_WEBHOOK_TOLERANCE = 600;

/**
 * Verify a Rakomi **publisher** webhook delivery — the recommended entry point for publisher apps.
 *
 * A thin, opinionated wrapper over the generic {@link verifyWebhook} — **zero crypto change, zero new
 * dependency** It:
 * (a) pre-binds the generic to {@link PublisherWebhookEvent} (no `<T>` to remember);
 * (b) defaults the replay tolerance to the publisher transport's **300 s** (clamped to the 600 s max);
 * (c) surfaces `eventType` from the `X-Rakomi-Event` header so `switch (data.eventType)` is an
 * exhaustive, open-set-typed discriminant (the body carries NO `type` field grounding);
 * (d) **rejects a non-`rksec_` secret outright** publisher secrets are always `rksec_`-prefixed
 * (reveal-once from the dashboard), closing the legacy raw-UTF-8 downgrade path the generic
 * tenant helper tolerates.
 *
 * NEVER throws — returns the SDK `VerifyResult` discriminated union. The error never embeds the
 * secret, decoded key, or computed HMAC.
 *
 * Idempotency: dedup on `data.webhookId` (the stable Standard Webhooks message id, constant across
 * retries). `data.deliveryId` is per-delivery diagnostics. See the contract doc for the full pattern.
 *
 * @public — additive-only after the first public release (names/params/return shape are SemVer-frozen).
 */
export async function verifyPublisherWebhook(
  body: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  options?: { tolerance?: number },
): Promise<VerifyResult<PublisherWebhookVerifyData>> {
  if (!secret.startsWith(RKSEC_PREFIX)) {
    return { ok: false, error: WEBHOOK_INVALID_SECRET() };
  }

  const rawTolerance = options?.tolerance ?? PUBLISHER_DEFAULT_TOLERANCE;
  const tolerance = Math.min(Math.max(0, rawTolerance), MAX_WEBHOOK_TOLERANCE);

  const result = await verifyWebhook<PublisherWebhookEvent>(body, headers, secret, tolerance);
  if (!result.ok) return result;

  const eventType = (getHeader(headers, 'x-rakomi-event') ?? '') as PublisherWebhookEventType;

  return {
    ok: true,
    data: {
      webhookId: result.data.webhookId,
      deliveryId: result.data.deliveryId,
      eventType,
      timestamp: result.data.timestamp,
      payload: result.data.payload,
    },
  };
}
