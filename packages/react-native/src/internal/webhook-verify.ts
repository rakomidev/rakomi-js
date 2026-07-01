
const RKSEC_PREFIX = 'rksec_';
const EXPECTED_KEY_LENGTH = 32;

/** Default publisher replay window (seconds) and the hard max clamp. */
export const DEFAULT_WEBHOOK_TOLERANCE = 300;
export const MAX_WEBHOOK_TOLERANCE = 600;

/** Portable webhook-verify error class — the value IS the cross-SDK conformance `error_class`. */
export type WebhookVerifyErrorClass =
  | 'invalid_signature'
  | 'invalid_secret'
  | 'missing_header'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'invalid_body';

/** Open-set publisher event type (the known catalog widened with the base string for forward-compat). */
export type PublisherEventType =
  | 'app.installed'
  | 'app.uninstalled'
  | 'app.install.scope_bump'
  | 'app.install.receipts_revoked'
  | 'publisher.created'
  | 'publisher.domain_verified'
  | 'publisher.dpa_accepted'
  | 'app.created'
  | 'app.version_published'
  | 'app.state_changed'
  | 'publisher.review_requested'
  | 'publisher.review_denied'
  | 'publisher.review_stale'
  | 'publisher.verified'
  | 'publisher.deverified'
  | 'publisher.subscription_activated'
  | 'publisher.subscription_lapsed';

export type PublisherWebhookEventType = PublisherEventType | (string & {});

/** The flat publisher-webhook delivery body. Unknown fields tolerated (forward-compat). No end-user PII. */
export interface PublisherWebhookEvent {
  publisher_id: string;
  correlation_id: string;
  installation_id?: string;
  app_id?: string;
  app_version_id?: string;
  actor_axis?: string;
  install_state_from?: string;
  install_state_to?: string;
  revoked_count?: number;
  already_revoked_count?: number;
  [key: string]: unknown;
}

export interface PublisherWebhookVerifyData {
  /** Stable Standard Webhooks message id — the at-least-once dedup key. */
  webhookId: string;
  /** Per-delivery id (diagnostics/logging). */
  deliveryId: string;
  /** Event type from the X-Rakomi-Event header (open set). */
  eventType: PublisherWebhookEventType;
  timestamp: number;
  payload: PublisherWebhookEvent;
}

export type WebhookVerifyResult =
  | { ok: true; data: PublisherWebhookVerifyData }
  | { ok: false; error: WebhookVerifyErrorClass };

type Headers = Record<string, string | string[] | undefined>;

function getHeader(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      const v = Array.isArray(value) ? value[0] : value;
      return v?.trim();
    }
  }
  return undefined;
}

/** Decode base64 (standard or url-safe) to bytes via atob. Returns null on malformed input (no throw). */
function base64ToBytes(input: string, urlSafe: boolean): Uint8Array | null {
  try {
    let s = urlSafe ? input.replace(/-/g, '+').replace(/_/g, '/') : input;
    const pad = s.length % 4;
    if (pad) s += '='.repeat(4 - pad);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function deriveKey(secret: string): Uint8Array | null {
  const encoded = secret.startsWith(RKSEC_PREFIX) ? secret.slice(RKSEC_PREFIX.length) : secret;
  const key = base64ToBytes(encoded, true);
  if (!key || key.length !== EXPECTED_KEY_LENGTH) return null;
  return key;
}

/** Constant-time equality — always touches all bytes, no early return, no data-dependent branch. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Copy a Uint8Array into a fresh, plain ArrayBuffer (a valid WebCrypto `BufferSource`, never a
 *  SharedArrayBuffer-backed view — keeps the strict lib.dom `BufferSource` typing happy). */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle is unavailable — a crypto polyfill (e.g. expo-crypto) is required');
  }
  const cryptoKey = await subtle.importKey(
    'raw',
    toArrayBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, toArrayBuffer(data));
  return new Uint8Array(sig);
}

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function bytesToUtf8(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: false }).decode(body);
}

/**
 * Raw generic verify (advanced use). ASYNC (WebCrypto). Never throws except when WebCrypto is entirely
 * absent (a misconfigured runtime) — that surfaces a clear error rather than a silent mis-verify.
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: Headers,
  secret: string,
  tolerance: number = DEFAULT_WEBHOOK_TOLERANCE,
): Promise<WebhookVerifyResult> {
  const signature = getHeader(headers, 'webhook-signature');
  const timestampStr = getHeader(headers, 'webhook-timestamp');
  const webhookId = getHeader(headers, 'webhook-id');
  if (!signature || !timestampStr || !webhookId) {
    return { ok: false, error: 'missing_header' };
  }

  if (!/^-?\d+$/.test(timestampStr)) {
    return { ok: false, error: 'missing_header' };
  }
  const timestamp = parseInt(timestampStr, 10);

  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff > tolerance) return { ok: false, error: 'timestamp_too_old' };
  if (diff < -tolerance) return { ok: false, error: 'timestamp_too_new' };

  const key = deriveKey(secret);
  if (!key) return { ok: false, error: 'invalid_secret' };

  const bodyString = bytesToUtf8(body);
  const signedContent = `${webhookId}.${timestampStr}.${bodyString}`;
  const expected = await hmacSha256(key, toBytes(signedContent));

  let matched = false;
  for (const raw of signature.split(' ')) {
    const entry = raw.trim();
    if (!entry.startsWith('v1,')) continue;
    const candidate = base64ToBytes(entry.slice(3), false);
    if (!candidate || candidate.length !== EXPECTED_KEY_LENGTH) continue;
    if (timingSafeEqual(expected, candidate)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { ok: false, error: 'invalid_signature' };

  let payload: PublisherWebhookEvent;
  try {
    payload = JSON.parse(bodyString) as PublisherWebhookEvent;
    if (typeof payload !== 'object' || payload === null) return { ok: false, error: 'invalid_body' };
  } catch {
    return { ok: false, error: 'invalid_body' };
  }

  const deliveryId = getHeader(headers, 'x-rakomi-delivery-id') ?? webhookId;
  const eventType = (getHeader(headers, 'x-rakomi-event') ?? '') as PublisherWebhookEventType;
  return { ok: true, data: { webhookId, deliveryId, eventType, timestamp, payload } };
}

/**
 * Recommended publisher entry point. Pre-binds the 300 s window (clamped ≤600) and REJECTS a non-`rksec_`
 * secret outright. ASYNC (WebCrypto) — `await` it. Mirrors `@rakomi/node`'s `verifyPublisherWebhook`.
 */
export async function verifyPublisherWebhook(
  body: string | Uint8Array,
  headers: Headers,
  secret: string,
  tolerance: number = DEFAULT_WEBHOOK_TOLERANCE,
): Promise<WebhookVerifyResult> {
  if (!secret.startsWith(RKSEC_PREFIX)) return { ok: false, error: 'invalid_secret' };
  const clamped = Math.min(Math.max(0, tolerance), MAX_WEBHOOK_TOLERANCE);
  return verifyWebhook(body, headers, secret, clamped);
}
