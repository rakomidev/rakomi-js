/**
 * RFC 7636 PKCE (Proof Key for Code Exchange) — platform-neutral algorithm.
 *
 * Takes a `CryptoProvider` so the same algorithm runs on Web Crypto (web) and
 * `expo-crypto` (RN/Expo).
 *
 * Security invariants:
 * - 32 random bytes from CSPRNG → base64url → 43-char `code_verifier` (RFC 7636 §4.1, exceeds the 43-char minimum).
 * - `code_challenge_method` is hardcoded `S256`. Never `plain`.
 * - Output is base64url-encoded per RFC 4648 §5 (URL-safe, no padding).
 * - NEVER use `Math.random`.
 */

import type { CryptoProvider } from '../types/adapters.js';

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Base64url encode (RFC 4648 §5 — URL-safe, no padding).
 *
 * Avoids `btoa` (not present in older Hermes / Node test envs) — pure byte->char loop.
 */
export function base64url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    const c = bytes[i + 2]!;
    result += alphabet[a >> 2];
    result += alphabet[((a & 0x03) << 4) | (b >> 4)];
    result += alphabet[((b & 0x0f) << 2) | (c >> 6)];
    result += alphabet[c & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const a = bytes[i]!;
    result += alphabet[a >> 2];
    result += alphabet[(a & 0x03) << 4];
  } else if (remaining === 2) {
    const a = bytes[i]!;
    const b = bytes[i + 1]!;
    result += alphabet[a >> 2];
    result += alphabet[((a & 0x03) << 4) | (b >> 4)];
    result += alphabet[(b & 0x0f) << 2];
  }
  return result.replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Generate a PKCE `code_verifier` + `code_challenge` pair (S256).
 *
 * Caller injects a `CryptoProvider`:
 *  - Web (`@rakomi/react`): wraps `crypto.getRandomValues` + `crypto.subtle.digest`.
 *  - RN/Expo (`@rakomi/react-native`): wraps `expo-crypto.getRandomBytesAsync` + `digestStringAsync`.
 *
 * @returns 43-char base64url verifier + base64url-encoded SHA-256 challenge.
 */
export async function generatePkce(crypto: CryptoProvider): Promise<PkceChallenge> {
  const verifierBytes = await crypto.getRandomBytes(32);
  if (verifierBytes.length !== 32) {
    throw new Error('CryptoProvider.getRandomBytes returned wrong length (expected 32).');
  }
  const codeVerifier = base64url(verifierBytes);

  const verifierAscii = new Uint8Array(codeVerifier.length);
  for (let i = 0; i < codeVerifier.length; i++) {
    verifierAscii[i] = codeVerifier.charCodeAt(i);
  }
  const digest = await crypto.digestSha256(verifierAscii);
  const codeChallenge = base64url(digest);

  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}
