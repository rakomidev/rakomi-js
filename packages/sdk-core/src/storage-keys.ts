/**
 * Per-tenant secure-store key derivation (HKDF-style domain separation).
 *
 * finding + * - Salt: `'rakomi:rn-store:v1'`
 * - Info: `tenantId` (via the publishable key resolution)
 * - Output base: `'rakomi.refresh.<tenantHash>'` etc.
 *
 * NOT a full HKDF here — that requires HMAC-SHA256, which the `CryptoProvider`
 * adapter does not currently expose. Instead we use a domain-separated SHA-256
 * pre-image: `salt | 0x00 | info | 0x00 | tenantId`. This gives us:
 * - Different salts → different keys (domain separation invariant).
 * - No HMAC requirement on the adapter.
 * - Forward-compat: when adapter exposes HMAC, swap to RFC 5869 HKDF without breaking
 * consumer-visible storage keys (the `v1` salt component is the migration token).
 */

import { base64url } from './oauth/pkce.js';
import type { CryptoProvider } from './types/adapters.js';

const SALT = 'rakomi:rn-store:v1';

/** Map a key purpose to a literal namespace. */
export type StorageKeyPurpose = 'refresh_token' | 'access_token' | 'jwks_cache' | 'oauth_state' | 'oauth_pkce' | 'session_id' | 'last_active' | 'tenant_install_id';

const PURPOSE_PREFIX: Record<StorageKeyPurpose, string> = {
  refresh_token: 'rakomi.rt',
  access_token: 'rakomi.at',
  jwks_cache: 'rakomi.jwks',
  oauth_state: 'rakomi.oauth.state',
  oauth_pkce: 'rakomi.oauth.pkce',
  session_id: 'rakomi.sid',
  last_active: 'rakomi.last_active',
  tenant_install_id: 'rakomi.install_id',
};

/**
 * Derive a stable storage key for `purpose` scoped to `tenantId`.
 *
 * Output format: `<purpose-prefix>.<22-char-base64url-tenant-hash>`. Using a
 * truncated hash (not the raw tenantId) means:
 *   - Storage keys do not leak tenant slugs to OS-level keychain dumps.
 *   - Stable across launches (deterministic).
 *   - Domain-separated by `SALT` from any future v2 layout.
 */
export async function deriveTenantStorageKey(
  crypto: CryptoProvider,
  tenantId: string,
  purpose: StorageKeyPurpose,
): Promise<string> {
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode(SALT);
  const tenantBytes = encoder.encode(tenantId);
  const purposeBytes = encoder.encode(purpose);

  const buf = new Uint8Array(saltBytes.length + 1 + purposeBytes.length + 1 + tenantBytes.length);
  let offset = 0;
  buf.set(saltBytes, offset);
  offset += saltBytes.length;
  buf[offset++] = 0;
  buf.set(purposeBytes, offset);
  offset += purposeBytes.length;
  buf[offset++] = 0;
  buf.set(tenantBytes, offset);

  const digest = await crypto.digestSha256(buf);
  const truncated = digest.subarray(0, 16);
  return `${PURPOSE_PREFIX[purpose]}.${base64url(truncated)}`;
}
