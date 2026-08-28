
export const GA_LOCALES = [
  'en',
  'pl',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'ga',
  'hr',
  'hu',
  'it',
  'lt',
  'lv',
  'mt',
  'nl',
  'pt',
  'ro',
  'sk',
  'sl',
  'sv',
] as const;

export type GaLocale = (typeof GA_LOCALES)[number];

export const GA_LOCALES_TRANSLATED = [
  'en',
  'pl',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'pt',
  'ro',
  'cs',
  'hu',
  'el',
  'sv',
  'bg',
  'da',
  'fi',
  'sk',
  'sl',
  'hr',
  'lt',
  'lv',
  'et',
  'mt',
  'ga',
] as const satisfies readonly GaLocale[];

export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Alpha-composite foreground over background at given opacity (0-1).
 * Clamps opacity to [0, 1]. Returns bg for invalid hex inputs.
 */
export function blendColors(foreground: string, background: string, opacity: number): string {
  if (!HEX_COLOR_REGEX.test(foreground) || !HEX_COLOR_REGEX.test(background)) return background;

  const a = Math.max(0, Math.min(1, opacity));

  const fR = parseInt(foreground.slice(1, 3), 16);
  const fG = parseInt(foreground.slice(3, 5), 16);
  const fB = parseInt(foreground.slice(5, 7), 16);
  const bR = parseInt(background.slice(1, 3), 16);
  const bG = parseInt(background.slice(3, 5), 16);
  const bB = parseInt(background.slice(5, 7), 16);

  const rR = Math.round(fR * a + bR * (1 - a));
  const rG = Math.round(fG * a + bG * (1 - a));
  const rB = Math.round(fB * a + bB * (1 - a));

  return `#${rR.toString(16).padStart(2, '0')}${rG.toString(16).padStart(2, '0')}${rB.toString(16).padStart(2, '0')}`;
}

/**
 * Darken a hex color by a percentage (0-100).
 * Returns input unchanged for invalid hex.
 * Edge case: if result equals input (e.g., #000000), lightens instead.
 */
export function darkenHex(hex: string, percent: number): string {
  if (!HEX_COLOR_REGEX.test(hex)) return hex;

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const factor = 1 - percent / 100;

  const dr = Math.round(Math.max(0, Math.min(255, r * factor)));
  const dg = Math.round(Math.max(0, Math.min(255, g * factor)));
  const db = Math.round(Math.max(0, Math.min(255, b * factor)));

  const result = `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;

  if (result === hex.toLowerCase().trim()) {
    const bump = Math.max(1, Math.abs(percent));
    const lr = Math.round(Math.min(255, r + bump * 2.55));
    const lg = Math.round(Math.min(255, g + bump * 2.55));
    const lb = Math.round(Math.min(255, b + bump * 2.55));
    return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
  }

  return result;
}

/**
 * Parse hex color (#rrggbb) to HSL [h, s, l].
 * h: 0-360, s: 0-100, l: 0-100.
 * Returns [0, 0, 50] (neutral gray) for invalid input.
 *
 * ⚠ `s` IS LIGHTNESS-NORMALIZED, so it is NOT a measure of colourfulness: near the light and dark
 * ends a tiny RGB range reads back as a large saturation (a chroma of ~0.03 at 96% lightness is
 * "47% saturated"). For a perceived-colourfulness DECISION (does this page sit in the same family as
 * a hue?), compute chroma — `(1 - |2l/100 - 1|) * s/100` — rather than reading `s` directly.
 */
export function hexToHsl(hex: string): [number, number, number] {
  if (!HEX_COLOR_REGEX.test(hex)) return [0, 0, 50];

  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / delta + 2) * 60;
    else h = ((r - g) / delta + 4) * 60;
  }

  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

export function relativeLuminance(hex: string): number {
  const safeHex = HEX_COLOR_REGEX.test(hex) ? hex : "#808080";
  const r = parseInt(safeHex.slice(1, 3), 16) / 255;
  const g = parseInt(safeHex.slice(3, 5), 16) / 255;
  const b = parseInt(safeHex.slice(5, 7), 16) / 255;

  const linearize = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Convert HSL to hex color (#rrggbb).
 * Clamps inputs: h wraps 0-360, s/l clamped 0-100.
 */
export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Derive bg-secondary: slight luminance shift for cards/sections.
 * Light bg (luminance >= 0.5): darken by 3%. Dark bg: lighten by 5%.
 *
 * **The property these two numbers preserve:** a nested surface must be perceptibly distinct from the
 * page behind it while remaining the same colour — never a second background. The shift is ASYMMETRIC
 * (3% down on light, 5% up on dark) because the eye resolves luminance differences less readily at the
 * dark end, so an equal shift would be invisible there. That asymmetry is the load-bearing part: an
 * "obvious tidy-up" to one shared constant would make dark surfaces flat.
 */
export function derivedBgSecondaryColor(bgHex: string): string {
  const [h, s, l] = hexToHsl(bgHex);
  const lum = relativeLuminance(bgHex);
  const newL = lum >= 0.5 ? l - 3 : l + 5;
  return hslToHex(h, s, newL);
}

/**
 * Derive border color by blending primary over background.
 * Adaptive opacity: 0.25 for light backgrounds, 0.40 for dark.
 *
 * **The property these two numbers preserve:** the border must stay visible against its own background
 * across the whole hue circle while never competing with the text. Like the secondary-background shift
 * above, the opacity is ASYMMETRIC and for the same reason — a border needs more presence on a dark
 * surface to register at all. Equalising them is the specific change that makes dark-theme borders
 * disappear, which is why the two values are named separately rather than folded into one.
 */
export function derivedBorderColor(primaryHex: string, bgHex: string): string {
  const opacity = relativeLuminance(bgHex) >= 0.5 ? 0.25 : 0.40;
  return blendColors(primaryHex, bgHex, opacity);
}

export type GaLocaleTranslated = (typeof GA_LOCALES_TRANSLATED)[number];

export function hasGaLocaleTranslation(value: unknown): value is GaLocaleTranslated {
  return typeof value === 'string' && (GA_LOCALES_TRANSLATED as readonly string[]).includes(value);
}

export function interpolate(
  template: string,
  params?: Record<string, string | number | undefined | null>,
): string {
  return template.replace(/\\\{|\{(\w+)\}/g, (match, key?: string) => {
    if (match === '\\{') return '{';
    if (!params) return match;
    const v = params[key!];
    if (v === undefined || v === null) return match;
    return String(v);
  });
}

export function isGaLocale(value: unknown): value is GaLocale {
  return typeof value === 'string' && (GA_LOCALES as readonly string[]).includes(value);
}

/**
 * WCAG 2.1 contrast ratio between two hex colors.
 * @returns ratio >= 1 (e.g. 4.5 for AA normal text)
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick the more READABLE of the two standard text colours for a given surface, by MEASURED contrast.
 *
 * ⚠ Why this is not `derivedTextColor`: that function splits on `relativeLuminance >= 0.5`, and a
 * threshold picks the WRONG candidate through the middle of the scale. Measured: `#8ab4f8` has
 * luminance 0.448, so the threshold calls it "dark" and suggests light text at ~2:1 — while dark text
 * on the same surface measures ~8:1. Comparing the two candidates cannot make that mistake, because it
 * asks the question the caller actually has ("which of these two can be read?") instead of a proxy for
 * it.
 *
 * Used for the button TEXT suggestion, where the surface is the button FILL rather than the page.
 * `derivedTextColor` is deliberately left alone: changing it would alter an already-published value for
 * every tenant that never set a text colour, which is a visible change needing its own decision.
 */
export function readableTextOn(surfaceHex: string): string {
  const dark = '#111827';
  const light = '#f9fafb';
  if (!HEX_COLOR_REGEX.test(surfaceHex)) return dark;
  return contrastRatio(dark, surfaceHex) >= contrastRatio(light, surfaceHex) ? dark : light;
}
