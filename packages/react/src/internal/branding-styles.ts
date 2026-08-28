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
  readableTextOn,
} from '../_inlined-symbols.js';

import type { BrandingConfig, BrandingPalette } from '../types.js';

/**
 * Build CSS custom property overrides from branding config.
 * Returns a React CSSProperties object to spread onto the card element's style.
 */

let _hcInitialized = false;
let _hcValue = false;
let _hcForcedColors: MediaQueryList | null = null;
let _hcPrefersMore: MediaQueryList | null = null;

let _csInitialized = false;
let _csPrefersDark = false;
let _csQuery: MediaQueryList | null = null;

function _updateColorScheme(): void {
  _csPrefersDark = _csQuery?.matches ?? false;
}

/**
 * How the painted palette is selected, when the host application has an opinion.
 *
 * `explicitScheme` is the scheme the integrator named; `prefersDark` is the end user's own preference,
 * supplied by the caller so it can come from a subscribed source rather than a one-shot read.
 */
export interface BrandingSchemeOptions {
  explicitScheme?: 'light' | 'dark' | 'auto' | undefined;
  prefersDark?: boolean | undefined;
}

const _csSubscribers = new Set<() => void>();

function _notifyColorSchemeSubscribers(): void {
  _updateColorScheme();
  for (const cb of _csSubscribers) cb();
}

function _initColorScheme(): void {
  if (_csInitialized) return;
  _csInitialized = true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  try {
    _csQuery = window.matchMedia('(prefers-color-scheme: dark)');
    _updateColorScheme();
    try {
      _csQuery.addEventListener('change', _notifyColorSchemeSubscribers);
    } catch { }
  } catch {
    _csPrefersDark = false;
  }
}

/** Does the end user prefer a dark colour scheme? (SSR-safe; false when unknown.) */
function prefersDarkScheme(): boolean {
  _initColorScheme();
  return _csPrefersDark;
}

/**
 * `useSyncExternalStore` triple for the end user's colour-scheme preference.
 *
 * ⚠ Without a real subscription the preference is read ONCE per render and a mid-session theme flip
 * repaints nothing — which would quietly withdraw the reason both palettes travel in one cached
 * response. The server snapshot is deliberately `false`: the preference is unknowable on the server,
 * and returning a stable value is what lets the client reconcile it after hydration instead of
 * mismatching during it.
 */
export function subscribeToColorScheme(onChange: () => void): () => void {
  _initColorScheme();
  _csSubscribers.add(onChange);
  return () => { _csSubscribers.delete(onChange); };
}

export function getColorSchemeSnapshot(): boolean {
  _initColorScheme();
  return _csPrefersDark;
}

export function getColorSchemeServerSnapshot(): boolean {
  return false;
}

/**
 * Which palette actually paints, and what `color-scheme` to declare.
 *
 * `themeMode` is a CAPABILITY declaration, not a rendering instruction: `light` / `dark` force that
 * scheme regardless of the end user's preference, `both` follows the preference. An absent or
 * unrecognised mode resolves to light — the flat fields are always the light palette, so that is the
 * one resolution guaranteed to render something correct.
 */
export function resolveBrandingPalette(
  branding: BrandingConfig,
  options?: BrandingSchemeOptions,
): {
  palette: BrandingPalette;
  colorScheme: 'light' | 'dark' | 'light dark';
} {
  const explicit = options?.explicitScheme === 'light' || options?.explicitScheme === 'dark'
    ? options.explicitScheme
    : undefined;
  const prefersDarkNow = (): boolean =>
    explicit ? explicit === 'dark' : (options?.prefersDark ?? prefersDarkScheme());
  const declare = (derived: 'light' | 'dark' | 'light dark'): 'light' | 'dark' | 'light dark' =>
    explicit ?? derived;
  const flat: BrandingPalette = {
    ...(branding.logoUrl ? { logoUrl: branding.logoUrl } : {}),
    ...(branding.primaryColor ? { primaryColor: branding.primaryColor } : {}),
    ...(branding.backgroundColor ? { backgroundColor: branding.backgroundColor } : {}),
    ...(branding.buttonColor ? { buttonColor: branding.buttonColor } : {}),
    ...(branding.buttonTextColor ? { buttonTextColor: branding.buttonTextColor } : {}),
    ...(branding.textColor ? { textColor: branding.textColor } : {}),
    ...(branding.headingColor ? { headingColor: branding.headingColor } : {}),
  };

  if (branding.themeMode === 'dark' && branding.dark) {
    return { palette: branding.dark, colorScheme: declare('dark') };
  }
  if (branding.themeMode === 'both' && branding.dark) {
    return prefersDarkNow()
      ? { palette: branding.dark, colorScheme: declare('light dark') }
      : { palette: flat, colorScheme: declare('light dark') };
  }
  return { palette: flat, colorScheme: declare('light') };
}

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

export function applyBranding(branding: BrandingConfig | null | undefined, options?: BrandingSchemeOptions): React.CSSProperties | undefined {
  if (!branding) return undefined;

  const vars: Record<string, string> = {};
  const highContrast = isHighContrastMode();
  const { palette, colorScheme } = resolveBrandingPalette(branding, options);

  if (!highContrast) {
    vars['colorScheme'] = colorScheme;
    if (palette.primaryColor) {
      vars['--rakomi-color-primary'] = palette.primaryColor;
    }
    if (palette.backgroundColor) {
      vars['--rakomi-color-bg'] = palette.backgroundColor;
    }
    if (palette.textColor) {
      vars['--rakomi-color-text'] = palette.textColor;
    }
    if (palette.buttonColor) {
      vars['--rakomi-color-primary-hover'] = darkenHex(palette.buttonColor, 10);
      if (!palette.primaryColor) {
        vars['--rakomi-color-primary'] = palette.buttonColor;
      }
    }
    const fill = palette.buttonColor ?? palette.primaryColor;
    const onFill = palette.buttonTextColor
      ?? (fill && HEX_COLOR_REGEX.test(fill) ? readableTextOn(fill) : undefined);
    if (onFill) {
      vars['--rakomi-color-primary-foreground'] = onFill;
    }
    if (palette.headingColor) {
      vars['--rakomi-color-heading'] = palette.headingColor;
    }
    if (palette.backgroundColor && HEX_COLOR_REGEX.test(palette.backgroundColor)) {
      vars['--rakomi-color-bg-secondary'] = derivedBgSecondaryColor(palette.backgroundColor);
    }
    if (palette.primaryColor && palette.backgroundColor
        && HEX_COLOR_REGEX.test(palette.primaryColor) && HEX_COLOR_REGEX.test(palette.backgroundColor)) {
      vars['--rakomi-color-border'] = derivedBorderColor(palette.primaryColor, palette.backgroundColor);
      vars['--rakomi-color-ring'] = blendColors(palette.primaryColor, palette.backgroundColor, 0.50);
    }
    if (palette.textColor && palette.backgroundColor
        && HEX_COLOR_REGEX.test(palette.textColor) && HEX_COLOR_REGEX.test(palette.backgroundColor)) {
      vars['--rakomi-color-muted'] = blendColors(palette.textColor, palette.backgroundColor, 0.45);
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
  const paletteHasStyles = (p: BrandingPalette | undefined): boolean =>
    !!(p && (p.primaryColor || p.backgroundColor || p.buttonColor || p.buttonTextColor || p.textColor || p.headingColor || p.logoUrl));
  return !!(
    branding.primaryColor || branding.backgroundColor || branding.buttonColor || branding.buttonTextColor
    || branding.textColor || branding.headingColor || branding.borderRadius || branding.logoUrl
    || paletteHasStyles(branding.dark)
  );
}
