// SPDX-License-Identifier: MIT

import { createHash, randomBytes } from 'node:crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** RFC 7636 §4.1: 43-128 char unreserved-charset string. 32 random bytes → 43-char base64url — the floor. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** RFC 7636 §4.2 `S256`: `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`. */
export function codeChallengeS256(codeVerifier: string): string {
  return base64url(createHash('sha256').update(codeVerifier, 'ascii').digest());
}

/** RFC 6749 §10.12 CSRF `state` — opaque, unguessable, unrelated to the PKCE verifier. */
export function generateState(): string {
  return base64url(randomBytes(16));
}

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly state: string;
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: codeChallengeS256(codeVerifier),
    codeChallengeMethod: 'S256',
    state: generateState(),
  };
}
