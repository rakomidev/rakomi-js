import type { AuthConfig, BrandingConfig, BrandingPalette, SocialProviderFlags, ThemeMode } from './types/auth.js';

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

    const sameOriginLogo = (source: Record<string, unknown>): string | undefined => {
      const candidate = source['logo_url'];
      if (typeof candidate !== 'string') return undefined;
      try {
        return new URL(candidate).origin === new URL(baseUrl).origin ? candidate : undefined;
      } catch {
        return undefined;
      }
    };

    /**
     * An UNRECOGNISED theme mode resolves to `light`, it never rejects the response. The set is
     * published, so a member added later (say a high-contrast mode) must not break clients pinned to
     * this version — they should keep rendering the light palette, which is always present.
     */
    const parseThemeMode = (v: unknown): ThemeMode =>
      v === 'dark' || v === 'both' || v === 'light' ? v : 'light';

    const parsePalette = (source: Record<string, unknown>): BrandingPalette => {
      const paletteColor = (key: string) => {
        const v = source[key];
        return typeof v === 'string' && HEX_RE.test(v) ? v : undefined;
      };
      const paletteLogo = sameOriginLogo(source);
      return {
        ...(paletteLogo ? { logoUrl: paletteLogo } : {}),
        ...(paletteColor('primary_color') ? { primaryColor: paletteColor('primary_color') } : {}),
        ...(paletteColor('background_color') ? { backgroundColor: paletteColor('background_color') } : {}),
        ...(paletteColor('button_color') ? { buttonColor: paletteColor('button_color') } : {}),
        ...(paletteColor('button_text_color') ? { buttonTextColor: paletteColor('button_text_color') } : {}),
        ...(paletteColor('text_color') ? { textColor: paletteColor('text_color') } : {}),
        ...(paletteColor('heading_color') ? { headingColor: paletteColor('heading_color') } : {}),
      };
    };

    const rawDark = rawBranding['dark'];
    const dark = rawDark && typeof rawDark === 'object' && !Array.isArray(rawDark)
      ? parsePalette(rawDark as Record<string, unknown>)
      : undefined;

    const tenantName = safeStr('tenant_name');
    if (tenantName) {
      branding = {
        ...(logoUrl ? { logoUrl } : {}),
        ...(safeColor('primary_color') ? { primaryColor: safeColor('primary_color') } : {}),
        ...(safeColor('background_color') ? { backgroundColor: safeColor('background_color') } : {}),
        ...(safeColor('button_color') ? { buttonColor: safeColor('button_color') } : {}),
        ...(safeColor('button_text_color') ? { buttonTextColor: safeColor('button_text_color') } : {}),
        ...(safeColor('text_color') ? { textColor: safeColor('text_color') } : {}),
        ...(safeColor('heading_color') ? { headingColor: safeColor('heading_color') } : {}),
        ...(safeStr('border_radius') ? { borderRadius: safeStr('border_radius') } : {}),
        tenantName,
        ...('theme_mode' in rawBranding ? { themeMode: parseThemeMode(rawBranding['theme_mode']) } : {}),
        ...(dark ? { dark } : {}),
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
