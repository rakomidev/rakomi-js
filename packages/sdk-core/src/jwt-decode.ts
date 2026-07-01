/**
 * JWT payload decoder — platform-neutral, NO signature verification.
 *
 * Web SDK + RN SDK share this exact algorithm.
 *
 * Security:
 * - The decoded payload is trusted only for UI display purposes.
 * - Server-side verification is the source of truth.
 * - Rejects oversized tokens (DoS guard).
 * - Prototype-pollution-safe own-property spread.
 * - TextDecoder for multi-byte UTF-8 claim values.
 */

import type { SessionResource, UserResource } from './types/auth.js';

/**
 * Base64 -> bytes, platform-independent (no `atob` reliance).
 * Tolerates URL-safe (`-`, `_`) and standard (`+`, `/`) input; padding optional.
 */
function base64ToBytes(input: string): Uint8Array | null {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(pad);

  if (typeof atob === 'function') {
    try {
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }
  const lookup = new Uint8Array(256);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const bytes = new Uint8Array(Math.floor((padded.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = padded.charCodeAt(i);
    const c1 = padded.charCodeAt(i + 1);
    const c2 = padded.charCodeAt(i + 2);
    const c3 = padded.charCodeAt(i + 3);
    if (c0 === 0x3d) break;
    const b0 = lookup[c0]!;
    const b1 = lookup[c1]!;
    bytes[p++] = (b0 << 2) | (b1 >> 4);
    if (c2 !== 0x3d) {
      const b2 = lookup[c2]!;
      bytes[p++] = ((b1 & 0x0f) << 4) | (b2 >> 2);
      if (c3 !== 0x3d) {
        const b3 = lookup[c3]!;
        bytes[p++] = ((b2 & 0x03) << 6) | b3;
      }
    }
  }
  return bytes.subarray(0, p);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    if (token.length >= 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;

    const bytes = base64ToBytes(payload);
    if (!bytes) return null;

    const decoded =
      typeof TextDecoder !== 'undefined'
        ? new TextDecoder().decode(bytes)
        : bytesToUtf8(bytes);
    const json = JSON.parse(decoded) as unknown;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;

    return Object.assign({}, json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Polyfill for environments without TextDecoder (older Hermes). */
function bytesToUtf8(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++]!;
    if (c < 0x80) {
      result += String.fromCharCode(c);
    } else if (c < 0xe0) {
      const c2 = bytes[i++]!;
      result += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
    } else if (c < 0xf0) {
      const c2 = bytes[i++]!;
      const c3 = bytes[i++]!;
      result += String.fromCharCode(((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f));
    } else {
      const c2 = bytes[i++]!;
      const c3 = bytes[i++]!;
      const c4 = bytes[i++]!;
      const cp = ((c & 0x07) << 18) | ((c2 & 0x3f) << 12) | ((c3 & 0x3f) << 6) | (c4 & 0x3f);
      const adj = cp - 0x10000;
      result += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff));
    }
  }
  return result;
}

export function decodeUser(token: string): UserResource | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  const sub = payload['sub'];
  const tenantId = payload['tenant_id'];
  const rawEmail = payload['email'];
  const isAnonymous = payload['is_anonymous'] === true;

  if (typeof sub !== 'string' || !sub) return null;
  if (typeof tenantId !== 'string' || !tenantId) return null;

  let email: string;
  if (typeof rawEmail === 'string' && rawEmail) {
    email = rawEmail;
  } else if (isAnonymous) {
    email = '';
  } else {
    return null;
  }
  if (sub.length > 255 || email.length > 255 || tenantId.length > 255) return null;

  const exp = payload['exp'];
  if (typeof exp === 'number' && exp <= 0) return null;

  const DENIED = new Set(['__proto__', 'constructor', 'prototype']);
  const rawClaims: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (!DENIED.has(key)) rawClaims[key] = payload[key];
  }

  const roles = Array.isArray(payload['roles'])
    ? (payload['roles'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const permissions = Array.isArray(payload['permissions'])
    ? (payload['permissions'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const user: UserResource = { id: sub, email, tenantId, roles, permissions, rawClaims };
  if (typeof payload['mfa_verified'] === 'boolean') user.mfaVerified = payload['mfa_verified'];
  if (typeof payload['mfa_verified_at'] === 'string') user.mfaVerifiedAt = payload['mfa_verified_at'];
  if (Array.isArray(payload['amr'])) {
    user.amr = (payload['amr'] as unknown[]).filter((v): v is string => typeof v === 'string');
  }
  if (typeof payload['acr'] === 'string') user.acr = payload['acr'];
  if (isAnonymous) user.isAnonymous = true;
  return user;
}

export function decodeSession(token: string, expiresIn: number): Omit<SessionResource, 'isExpiringSoon'> | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sub = payload['sub'];
  const sid = payload['sid'];
  const tenantId = payload['tenant_id'];
  const iat = payload['iat'];
  if (typeof sub !== 'string' || !sub) return null;
  if (typeof sid !== 'string' || !sid) return null;
  if (typeof tenantId !== 'string' || !tenantId) return null;

  const maxLifetimeExpSeconds = payload['session_max_lifetime_exp'];
  const maxLifetimeExpiresAt: number | undefined =
    typeof maxLifetimeExpSeconds === 'number' ? maxLifetimeExpSeconds * 1000 : undefined;

  const expiresAtMs = Date.now() + expiresIn * 1000;
  const effectiveExpiresAt = Math.min(expiresAtMs, maxLifetimeExpiresAt ?? Infinity);
  const expiresInSeconds = Math.max(0, Math.floor((effectiveExpiresAt - Date.now()) / 1000));

  return {
    id: sid,
    userId: sub,
    tenantId,
    expiresAt: expiresAtMs,
    lastActiveAt: typeof iat === 'number' ? iat * 1000 : Date.now(),
    maxLifetimeExpiresAt,
    effectiveExpiresAt,
    expiresInSeconds,
  };
}
