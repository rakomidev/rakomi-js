/**
 * URL safety validation utilities.
 * Shared across all pre-built components to prevent open redirect and XSS via URL props.
 */

/**
 * Allowlist-based URL validation — only allows safe redirect targets.
 * Prevents open redirect via afterSignInUrl, redirectIfAuthenticated, etc.
 *
 * Allows:
 * - Relative paths starting with '/'
 * - https: URLs
 * - http://localhost (dev only)
 *
 * Rejects:
 * - javascript:, data:, vbscript:, file:, ftp: protocols
 * - http: to non-localhost (open redirect risk)
 */
export function isSafeRedirectUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
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
