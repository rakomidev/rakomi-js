/**
 * Pure utilities shared across web + RN SDKs.
 */

/** Placeholder origin used only to resolve a relative path; never contacted. */
const RELATIVE_RESOLUTION_BASE = 'https://relative-path.invalid';

/**
 * True when `value` is a path that stays on the current origin. Starting with "/" is not
 * enough: "//host", "/\\host" and a "/" followed by a tab or newline and another "/" resolve to
 * a different origin, so the value is resolved against a placeholder origin and must resolve
 * back to it. Control characters are rejected outright.
 */
function isSameOriginPath(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  try {
    return new URL(value, RELATIVE_RESOLUTION_BASE).origin === RELATIVE_RESOLUTION_BASE;
  } catch {
    return false;
  }
}

/**
 * Validate a URL string for use as a `returnTo` / `redirect_uri` value.
 * Rejects javascript:/data:/file:/vbscript: schemes (XSS-style payloads), absolute URLs
 * outside the allow-list, and IDN punycode trickery.
 *
 * Returns the URL string if safe, null otherwise.
 *
 * Safe outputs:
 *  - Same-origin relative paths starting with `/` (web context); protocol-relative and
 *    backslash forms such as `//host` or `/\\host` are rejected.
 *  - Custom-scheme deep links matching `^[a-z][a-z0-9+.-]*:` (RFC 3986 §3.1) with a host.
 *
 * On RN custom schemes (`rakomi://callback`, `myapp://callback`) ARE valid here.
 */
export function isSafeUrl(url: string, allowedSchemes: readonly string[] = ['http', 'https']): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;

  if (url.startsWith('/')) return isSameOriginPath(url);

  if (/[\x00-\x1f\x7f]/.test(url)) return false;

  const match = url.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
  if (!match) return false;
  const scheme = match[1]!.toLowerCase();
  const dangerous = new Set(['javascript', 'data', 'file', 'vbscript', 'about', 'blob']);
  if (dangerous.has(scheme)) return false;

  if (!allowedSchemes.includes(scheme)) return false;

  try {
    const parsed = new URL(url);
    if (parsed.hostname && parsed.hostname !== parsed.hostname.toLowerCase()) return false;
  } catch {
  }
  return true;
}

export type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

/**
 * Heuristic strength scorer (Pure JS, no zxcvbn dep bundle budget).
 * NOT a security guarantee on its own; tenant policy is server-enforced.
 */
export function scorePassword(password: string): PasswordStrength {
  if (!password) return 'weak';
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (score <= 1) return 'weak';
  if (score === 2) return 'fair';
  if (score === 3) return 'good';
  return 'strong';
}
