/**
 * Browser-safe OAuth state parameter generation.
 * Uses crypto.getRandomValues() — NEVER Math.random().
 *
 * State is stored in sessionStorage (single-use, single-tab) and validated
 * on callback to prevent CSRF attacks.
 */

/**
 * Generate a random OAuth state parameter.
 * Returns 32 random bytes encoded as a 64-char hex string.
 */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
