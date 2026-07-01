/**
 * Per-request environment detection based on hostname.
 * Safe default: production (never accidentally expose verbose errors).
 */

import type { SdkEnvironment } from './types.js';

const DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Detect environment from request hostname.
 * Returns 'development' for localhost, 127.0.0.1, ::1, *.local.
 * Returns 'production' for everything else (safe default).
 */
export function detectEnvironment(hostname: string): SdkEnvironment {
  if (!hostname) return 'production';

  if (DEV_HOSTNAMES.has(hostname)) return 'development';

  const host = hostname.includes(']:')
    ? hostname.slice(1, hostname.indexOf(']'))
    : hostname.lastIndexOf(':') > hostname.indexOf(':')
      ? hostname
      : hostname.split(':')[0]!;

  if (DEV_HOSTNAMES.has(host)) return 'development';
  if (host.endsWith('.local')) return 'development';
  return 'production';
}
