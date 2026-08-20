import type { AuthConfig, BrandingConfig, SocialProviderFlags } from './types/auth.js';

const UNSAFE_PROVIDER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Maps the snake_case `GET /v1/auth/config` wire response to the camelCase {@link AuthConfig}
 * shape — never throws on malformed input, defaults conservatively per field. `logoUrl` is kept
 * only when it shares an origin with `baseUrl` (@see RFC 6454).
 */
export function parseAuthConfigResponse(raw: unknown, baseUrl: string): AuthConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  let branding: BrandingConfig | undefined;
  const rawBranding = r['branding'] as Record<string, unknown> | undefined;
  if (rawBranding && typeof rawBranding === 'object') {
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    const safeStr = (key: string) => {
      const v = rawBranding[key];
      return typeof v === 'string' ? v : undefined;
    };
    const safeColor = (key: string) => {
      const v = safeStr(key);
      return v && HEX_RE.test(v) ? v : undefined;
    };

    let logoUrl: string | undefined;
    const rawLogoUrl = safeStr('logo_url');
    if (rawLogoUrl) {
      try {
        const logoOrigin = new URL(rawLogoUrl).origin;
        const baseOrigin = new URL(baseUrl).origin;
        if (logoOrigin === baseOrigin) logoUrl = rawLogoUrl;
      } catch { }
    }

    const tenantName = safeStr('tenant_name');
    if (tenantName) {
      branding = {
        ...(logoUrl ? { logoUrl } : {}),
        ...(safeColor('primary_color') ? { primaryColor: safeColor('primary_color') } : {}),
        ...(safeColor('background_color') ? { backgroundColor: safeColor('background_color') } : {}),
        ...(safeColor('button_color') ? { buttonColor: safeColor('button_color') } : {}),
        ...(safeColor('text_color') ? { textColor: safeColor('text_color') } : {}),
        ...(safeStr('border_radius') ? { borderRadius: safeStr('border_radius') } : {}),
        tenantName,
      };
    }
  }

  const rawSocialProviders = r['social_providers'];
  const socialProviders: Record<string, SocialProviderFlags> = {};
  if (rawSocialProviders && typeof rawSocialProviders === 'object' && !Array.isArray(rawSocialProviders)) {
    for (const [key, value] of Object.entries(rawSocialProviders as Record<string, unknown>)) {
      if (UNSAFE_PROVIDER_KEYS.has(key)) continue;
      const flags = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      socialProviders[key] = {
        signIn: flags['sign_in'] === true,
        signUp: flags['sign_up'] === true,
      };
    }
  }

  return {
    methods: Array.isArray(r['methods']) ? (r['methods'] as unknown[]).filter((m): m is string => typeof m === 'string') : [],
    socialProviders,
    mfaEnforced: typeof r['mfa_enforced'] === 'boolean' ? r['mfa_enforced'] : false,
    ...(typeof r['mfa_grace_period_hours'] === 'number' ? { mfaGracePeriodHours: r['mfa_grace_period_hours'] } : {}),
    ...(branding ? { branding } : {}),
  };
}
