export type Rgb = [number, number, number];

const INK = '#121414';
const PAPER = '#FFFFFF';
export const DEFAULT_BRAND = '#1F4D3A';

/** Parses #rgb, #rrggbb, rgb() and rgba(). Returns undefined for mostly transparent colours. */
export function parseColor(value: string | undefined): Rgb | undefined {
  const input = value?.trim().toLowerCase() ?? '';
  const short = input.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return [short[1], short[2], short[3]].map((digit) => Number.parseInt(`${digit}${digit}`, 16)) as Rgb;
  const hex = input.match(/^#([0-9a-f]{6})$/)?.[1];
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
  const rgb = input.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!rgb) return undefined;
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4]);
  if (alpha < 0.5) return undefined;
  return [rgb[1], rgb[2], rgb[3]].map((channel) => Math.min(255, Math.round(Number(channel)))) as Rgb;
}

export function toHex([red, green, blue]: Rgb): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function relativeLuminance([red, green, blue]: Rgb): number {
  const channel = (value: number) => {
    const normalized = Math.min(255, Math.max(0, value)) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((channel, index) => channel + ((to[index] ?? channel) - channel) * amount) as Rgb;
}

/** Spread between the strongest and weakest channel; greys and near-black/white score low. */
export function chroma([red, green, blue]: Rgb): number {
  return (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
}

/**
 * Picks the first candidate that reads as a brand colour: opaque, with some hue, and neither
 * close to white nor close to black. Dark brand colours (navy, forest green) are valid.
 */
export function pickBrandColor(candidates: Array<string | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    const rgb = parseColor(candidate);
    if (!rgb) continue;
    const luminance = relativeLuminance(rgb);
    if (chroma(rgb) >= 0.15 && luminance > 0.012 && luminance < 0.85) return toHex(rgb);
  }
  const preferred = parseColor(fallback);
  return preferred ? toHex(preferred) : DEFAULT_BRAND;
}

/** Moves a colour towards a target until it reaches the requested contrast against a background. */
function withContrast(color: Rgb, background: Rgb, target: Rgb, ratio: number): Rgb {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mix(color, target, step / 20);
    if (contrastRatio(candidate, background) >= ratio) return candidate;
  }
  return target;
}

export interface BrandPalette {
  /** The client colour, unchanged. */
  brand: string;
  /** Brand colour safe for small text and rules on white or tinted paper (4.5:1). */
  accent: string;
  /** Background for the cover panel and closing band: the brand itself when dark, otherwise ink. */
  deep: string;
  /** Body text on `deep`. */
  onDeep: string;
  /** Accent text on `deep` (eyebrows, rules). */
  deepAccent: string;
  /** Very light brand tint for paper backgrounds. */
  tint: string;
  /** Solid fill for buttons with readable label colour. */
  button: string;
  onButton: string;
}

export function brandPalette(color: string): BrandPalette {
  const brand = parseColor(color) ?? (parseColor(DEFAULT_BRAND) as Rgb);
  const white = parseColor(PAPER) as Rgb;
  const ink = parseColor(INK) as Rgb;
  const tint = mix(brand, white, 0.93);
  const accent = withContrast(brand, tint, ink, 4.5);
  const brandIsDark = contrastRatio(brand, white) >= 7;
  const deep = brandIsDark ? brand : mix(ink, brand, 0.06);
  const deepAccent = brandIsDark ? withContrast(mix(brand, white, 0.55), deep, white, 4.5) : withContrast(brand, deep, white, 4.5);
  const button = contrastRatio(brand, white) >= 4.5 ? brand : accent;
  return {
    brand: toHex(brand),
    accent: toHex(accent),
    deep: toHex(deep),
    onDeep: '#F7F5F0',
    deepAccent: toHex(deepAccent),
    tint: toHex(tint),
    button: toHex(button),
    onButton: contrastRatio(button, white) >= 4.5 ? '#FFFFFF' : INK,
  };
}

/** Whether a logo drawn for this background needs a dark backing to stay visible. */
export function isDarkBackground(color: string | undefined): boolean {
  const rgb = parseColor(color);
  return rgb ? relativeLuminance(rgb) < 0.2 : false;
}
