import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WEBHOOK_INVALID_BODY,
  WEBHOOK_INVALID_SECRET,
  WEBHOOK_INVALID_SIGNATURE,
  WEBHOOK_MISSING_HEADER,
  WEBHOOK_TIMESTAMP_TOO_NEW,
  WEBHOOK_TIMESTAMP_TOO_OLD,
} from './errors.js';
import type { VerifyResult, WebhookEvent, WebhookVerifyData } from './types.js';

const RKSEC_PREFIX = 'rksec_';
const EXPECTED_KEY_LENGTH = 32;

/**
 * Case-insensitive header lookup (RFC 9110 §5.1). Exported so the publisher wrapper can read the
 * `X-Rakomi-Event` header with the identical lookup semantics (no second header parser to drift).
 */
export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  let value = headers[lower];
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === lower) {
        value = headers[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) return value[0]?.trim();
  return value?.trim();
}

/**
 * Derive the raw HMAC key from a webhook signing secret.
 * Prefixed secrets (`rksec_<base64url>`) are stripped and base64url-decoded
 * to recover the original 32-byte key. Plain strings are used as-is.
 * Validates decoded key is exactly 32 bytes.
 */
function deriveKey(secret: string): Buffer | null {
  if (secret.startsWith(RKSEC_PREFIX)) {
    const key = Buffer.from(secret.slice(RKSEC_PREFIX.length), 'base64url');
    if (key.length !== EXPECTED_KEY_LENGTH) {
      return null;
    }
    return key;
  }
  return Buffer.from(secret, 'utf8');
}

export async function verifyWebhook<T = WebhookEvent>(
  body: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  tolerance: number,
): Promise<VerifyResult<WebhookVerifyData<T>>> {
  try {
    const signature = getHeader(headers, 'webhook-signature');
    const timestampStr = getHeader(headers, 'webhook-timestamp');
    const webhookId = getHeader(headers, 'webhook-id');
    const deliveryId = getHeader(headers, 'x-rakomi-delivery-id');

    if (!signature || !timestampStr || !webhookId) {
      return { ok: false, error: WEBHOOK_MISSING_HEADER() };
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return { ok: false, error: WEBHOOK_MISSING_HEADER() };
    }

    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff > tolerance) {
      return { ok: false, error: WEBHOOK_TIMESTAMP_TOO_OLD(tolerance) };
    }
    if (diff < -tolerance) {
      return { ok: false, error: WEBHOOK_TIMESTAMP_TOO_NEW(tolerance) };
    }

    const key = deriveKey(secret);
    if (!key) {
      return { ok: false, error: WEBHOOK_INVALID_SECRET() };
    }

    const bodyString = typeof body === 'string' ? body : body.toString('utf-8');

    const signedContent = `${webhookId}.${timestampStr}.${bodyString}`;
    const expectedSig = createHmac('sha256', key)
      .update(signedContent)
      .digest('base64');

    const signatureEntries = signature.split(' ').map((s) => s.trim()).filter(Boolean);
    let matched = false;

    for (const entry of signatureEntries) {
      if (!entry.startsWith('v1,')) continue;
      const receivedSig = entry.slice(3);

      try {
        const expectedRaw = Buffer.from(expectedSig, 'base64');
        const receivedRaw = Buffer.from(receivedSig, 'base64');

        if (
          expectedRaw.length === 32 &&
          receivedRaw.length === 32 &&
          timingSafeEqual(expectedRaw, receivedRaw)
        ) {
          matched = true;
          break;
        }
      } catch {
      }
    }

    if (!matched) {
      return { ok: false, error: WEBHOOK_INVALID_SIGNATURE() };
    }

    const parsed = JSON.parse(bodyString) as T;

    return {
      ok: true,
      data: { webhookId, deliveryId: deliveryId ?? webhookId, timestamp, payload: parsed },
    };
  } catch {
    return { ok: false, error: WEBHOOK_INVALID_BODY() };
  }
}
