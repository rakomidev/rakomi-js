/**
 * URL safety validation utilities.
 * Shared across all pre-built components to prevent open redirect and XSS via URL props.
 */

/** Placeholder origin used only to resolve a relative path; never contacted. */
const RELATIVE_RESOLUTION_BASE = 'https://relative-path.invalid';

/**
 * True when `value` is a path that stays on the current origin.
 *
 * Starting with "/" is not enough: browsers resolve "//host", "/\\host" and a "/" followed by a
 * tab or newline and another "/" to a different origin. The value is resolved against a
 * placeholder origin and accepted only if it resolves back to that same origin. Control
 * characters are rejected outright, since no legitimate app path contains them.
 */
export function isSameOriginPath(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
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
 * Allowlist-based URL validation — only allows safe redirect targets.
 * Prevents open redirect via afterSignInUrl, redirectIfAuthenticated, etc.
 *
 * Allows:
 * - Relative paths that stay on the current origin (see `isSameOriginPath`)
 * - https: URLs
 * - http://localhost (dev only)
 *
 * Rejects:
 * - javascript:, data:, vbscript:, file:, ftp: protocols
 * - http: to non-localhost (open redirect risk)
 */
export function isSafeRedirectUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith('/')) return isSameOriginPath(trimmed);
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates image src attributes — allows safe image sources only.
 * Used for logo props and QR code data URLs.
 */
export function isSafeImageSrc(src: string): boolean {
  const lower = src.trim().toLowerCase();
  if ((lower.startsWith('/') && !lower.startsWith('//')) || lower.startsWith('https:')) return true;
  if (lower.startsWith('http:')) {
    try {
      const parsed = new URL(src.trim());
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') return true;
    } catch { }
    return false;
  }
  if (lower.startsWith('data:image/')) return true;
  return false;
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Returns true if the baseUrl is http:// to a non-localhost origin (cleartext credentials risk). */
export function requiresHttpsUpgrade(baseUrl: string): boolean {
  if (!baseUrl.startsWith('http://')) return false;
  try {
    return !LOCALHOST_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return true;
  }
}
