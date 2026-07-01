/**
 * OAuth `state` parameter — single-use secret bound to the auth request.
 * + (constant-time comparison + 60s TTL single-use guard).
 *
 * 32 random bytes from CSPRNG → base64url. Persisted by adapter (web → sessionStorage,
 * RN → expo-secure-store). The deep-link callback validates + deletes (single-use).
 */

import type { CryptoProvider, KeyValueStore } from '../types/adapters.js';
import { base64url } from './pkce.js';

/** Constant-time string comparison (timing-attack defense). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface IssuedState {
  state: string;
  storageKey: string;
  /** Expiry — 60s after issuance per single-use guard. */
  expiresAt: number;
}

const STATE_PREFIX = 'rakomi.oauth.state.';
const STATE_TTL_MS = 60_000;

/** Issue a fresh OAuth state value, persist to storage, return the value + storage key. */
export async function issueState(crypto: CryptoProvider, storage: KeyValueStore, idHint?: string): Promise<IssuedState> {
  const bytes = await crypto.getRandomBytes(32);
  const state = base64url(bytes);
  const idBytes = await crypto.getRandomBytes(16);
  const id = idHint ?? base64url(idBytes);
  const storageKey = STATE_PREFIX + id;
  const expiresAt = Date.now() + STATE_TTL_MS;
  await storage.setItem(
    storageKey,
    JSON.stringify({ state, expiresAt }),
    { keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' },
  );
  return { state, storageKey, expiresAt };
}

/**
 * Validate a callback `state` value: looks up by storage key, deletes on read
 * (single-use enforcement), constant-time-compares with the candidate.
 */
export async function consumeState(storage: KeyValueStore, storageKey: string, candidate: string): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'expired' | 'mismatch' }> {
  const raw = await storage.getItem(storageKey);
  await storage.removeItem(storageKey).catch(() => undefined);
  if (!raw) return { ok: false, reason: 'missing' };
  try {
    const parsed = JSON.parse(raw) as { state: string; expiresAt: number };
    if (typeof parsed.state !== 'string' || typeof parsed.expiresAt !== 'number') {
      return { ok: false, reason: 'missing' };
    }
    if (Date.now() > parsed.expiresAt) return { ok: false, reason: 'expired' };
    if (!timingSafeStringEqual(parsed.state, candidate)) return { ok: false, reason: 'mismatch' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}
