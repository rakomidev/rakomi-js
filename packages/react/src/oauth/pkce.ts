/**
 * Browser PKCE — thin web platform shim over `@rakomi/sdk-core/oauth/pkce`.
 *
 * The PKCE algorithm lives in `@rakomi/sdk-core` behind a `CryptoProvider`
 * seam. This file wires Web Crypto (`crypto.subtle` + `crypto.getRandomValues`)
 * and preserves the `generatePKCE` signature used by the rest of the SDK.
 *
 * Security invariants:
 * - 32 random bytes from `crypto.getRandomValues` (CSPRNG) — never `Math.random`.
 * - SHA-256 via `crypto.subtle.digest` — same algorithm runs server-side.
 * - Web Crypto API requires HTTPS or localhost; runtime guard preserved.
 */

import type { CryptoProvider, PkceChallenge } from '@rakomi/sdk-core';
import { generatePkce } from '@rakomi/sdk-core';

export type { PkceChallenge };

const webCryptoProvider: CryptoProvider = {
  getRandomBytes: async (length) => {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      throw new Error(
        'Web Crypto API requires a secure context (HTTPS or localhost). PKCE generation failed.',
      );
    }
    const out = new Uint8Array(length);
    crypto.getRandomValues(out);
    return out;
  },
  digestSha256: async (input) => {
    if (typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') {
      throw new Error(
        'Web Crypto API requires a secure context (HTTPS or localhost). PKCE generation failed.',
      );
    }
    const buf = new Uint8Array(input.length);
    buf.set(input);
    const digest = await crypto.subtle.digest('SHA-256', buf.buffer);
    return new Uint8Array(digest);
  },
};

/**
 * Generate a PKCE `code_verifier` + `code_challenge` pair (S256).
 * Web-only convenience — RN consumers use `generatePkce(adapter.crypto)` directly.
 */
export async function generatePKCE(): Promise<PkceChallenge> {
  return generatePkce(webCryptoProvider);
}
