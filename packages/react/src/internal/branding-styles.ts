/**
 * Branding style helper — converts BrandingConfig into CSS custom properties.
 * Applied as inline `style` on existing `[data-rakomi-card]` element (no wrapper div).
 *
 * Specificity order (JSDoc):
 *   inline style > server branding CSS vars > appearance className > theme > media query > :root
 */

import {
  blendColors,
  darkenHex,
  derivedBgSecondaryColor,
  derivedBorderColor,
  HEX_COLOR_REGEX,
} from '../_inlined-symbols.js';

import type { BrandingConfig } from '../types.js';

/**
 * Build CSS custom property overrides from branding config.
 * Returns a React CSSProperties object to spread onto the card element's style.
 */

let _hcInitialized = false;
let _hcValue = false;
let _hcForcedColors: MediaQueryList | null = null;
let _hcPrefersMore: MediaQueryList | null = null;

function _updateHighContrast(): void {
  _hcValue = (_hcForcedColors?.matches ?? false) || (_hcPrefersMore?.matches ?? false);
}

/** Check if user has high-contrast mode active (SSR-safe). Singleton — matchMedia called once. */
function isHighContrastMode(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (!_hcInitialized) {
    _hcInitialized = true;
    try {
      _hcForcedColors = window.matchMedia('(forced-colors: active)');
      _hcPrefersMore = window.matchMedia('(prefers-contrast: more)');
      _updateHighContrast();
      _hcForcedColors.addEventListener('change', _updateHighContrast);
      _hcPrefersMore.addEventListener('change', _updateHighContrast);
    } catch {
      _hcValue = false;
    }
  }
  return _hcValue;
}

export function applyBranding(branding: BrandingConfig | null | undefined): React.CSSProperties | undefined {
  if (!branding) return undefined;

  const vars: Record<string, string> = {};
  const highContrast = isHighContrastMode();

  if (!highContrast) {
    if (branding.primaryColor) {
      vars['--rakomi-color-primary'] = branding.primaryColor;
    }
    if (branding.backgroundColor) {
      vars['--rakomi-color-bg'] = branding.backgroundColor;
    }
    if (branding.textColor) {
      vars['--rakomi-color-text'] = branding.textColor;
    }
    if (branding.buttonColor) {
      vars['--rakomi-color-primary-hover'] = darkenHex(branding.buttonColor, 10);
      if (!branding.primaryColor) {
        vars['--rakomi-color-primary'] = branding.buttonColor;
      }
    }
    if (branding.backgroundColor && HEX_COLOR_REGEX.test(branding.backgroundColor)) {
      vars['--rakomi-color-bg-secondary'] = derivedBgSecondaryColor(branding.backgroundColor);
    }
    if (branding.primaryColor && branding.backgroundColor
        && HEX_COLOR_REGEX.test(branding.primaryColor) && HEX_COLOR_REGEX.test(branding.backgroundColor)) {
      vars['--rakomi-color-border'] = derivedBorderColor(branding.primaryColor, branding.backgroundColor);
      vars['--rakomi-color-ring'] = blendColors(branding.primaryColor, branding.backgroundColor, 0.50);
    }
    if (branding.textColor && branding.backgroundColor
        && HEX_COLOR_REGEX.test(branding.textColor) && HEX_COLOR_REGEX.test(branding.backgroundColor)) {
      vars['--rakomi-color-muted'] = blendColors(branding.textColor, branding.backgroundColor, 0.45);
    }
  }
  if (branding.borderRadius) {
    vars['--rakomi-radius'] = branding.borderRadius;
  }

  return Object.keys(vars).length > 0 ? vars as unknown as React.CSSProperties : undefined;
}

/**
 * Returns `true` when branding has any visual fields set (for data-rakomi-branded attribute).
 */
export function hasBrandingStyles(branding: BrandingConfig | null | undefined): boolean {
  if (!branding) return false;
  return !!(branding.primaryColor || branding.backgroundColor || branding.buttonColor || branding.textColor || branding.borderRadius || branding.logoUrl);
}
