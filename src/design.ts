import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrandProfile } from './types.js';

/**
 * One design system per client: a contrast-safe palette derived from the brand colour and a
 * type pairing matched to the fonts on the client's own website. Every rendered asset (guide,
 * carousel, cards, motion clips) uses the same tokens so the campaign reads as one system.
 */

// ---------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------

export type Rgb = [number, number, number];

export interface Palette {
  /** The brand colour as used for fills and large marks. */
  accent: string;
  /** Accent darkened until it passes 4.5:1 as text on paper. */
  accentText: string;
  /** Text colour on an accent fill. */
  onAccent: string;
  /** Accent lightened until it passes 3:1 on the dark background (large type, rules, marks). */
  accentOnDark: string;
  /** Brand-tinted near-black for covers and dark slides. */
  dark: string;
  onDark: string;
  mutedOnDark: string;
  ruleOnDark: string;
  paper: string;
  paper2: string;
  ink: string;
  muted: string;
  rule: string;
  /** A soft accent tint for panels on paper. */
  tint: string;
}

const FALLBACK_ACCENT = '#1F4D3A';
const INK: Rgb = [21, 22, 22];
const WHITE: Rgb = [255, 255, 255];

export function derivePalette(brandColor: string | undefined, fallbackColor?: string): Palette {
  const accentRgb = pickAccent(brandColor, fallbackColor);
  const dark = mix(accentRgb, [11, 12, 12], 0.86);
  const paper = mix([249, 247, 242], accentRgb, 0.035);
  const accentText = adjustUntil(accentRgb, INK, (candidate) => contrast(candidate, paper) >= 4.5);
  const accentOnDark = adjustUntil(accentRgb, WHITE, (candidate) => contrast(candidate, dark) >= 4.2);
  const onAccent = contrast(WHITE, accentRgb) >= contrast(INK, accentRgb) ? '#FBFAF7' : toHex(INK);
  return {
    accent: toHex(accentRgb),
    accentText: toHex(accentText),
    onAccent,
    accentOnDark: toHex(accentOnDark),
    dark: toHex(dark),
    onDark: '#F5F2EC',
    mutedOnDark: toHex(mix([245, 242, 236], dark, 0.42)),
    ruleOnDark: 'rgba(245,242,236,.16)',
    paper: toHex(paper),
    paper2: toHex(mix([240, 236, 228], accentRgb, 0.05)),
    ink: toHex(INK),
    muted: '#666863',
    rule: 'rgba(21,22,22,.14)',
    tint: toHex(mix(paper, accentRgb, 0.09)),
  };
}

function pickAccent(primary: string | undefined, fallback: string | undefined): Rgb {
  for (const candidate of [primary, fallback]) {
    const rgb = candidate ? parseColor(candidate) : undefined;
    if (!rgb) continue;
    const luminance = relativeLuminance(rgb);
    const saturation = chroma(rgb);
    // Near-white, near-black and grey "brand colours" are usually button defaults, not the brand.
    if (luminance >= 0.03 && luminance <= 0.8 && saturation >= 0.12) return rgb;
  }
  return parseColor(FALLBACK_ACCENT) as Rgb;
}

/** Moves a colour towards a target in small steps until the predicate holds. */
function adjustUntil(color: Rgb, target: Rgb, ok: (candidate: Rgb) => boolean): Rgb {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mix(color, target, step * 0.05);
    if (ok(candidate)) return candidate;
  }
  return target;
}

export function parseColor(value: string): Rgb | undefined {
  const trimmed = value.trim();
  const short = trimmed.match(/^#([0-9a-f]{3})$/i)?.[1];
  if (short) return [...short].map((digit) => Number.parseInt(digit + digit, 16)) as Rgb;
  const hex = trimmed.match(/^#([0-9a-f]{6})/i)?.[1];
  if (hex) return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
  const rgb = trimmed.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?/i);
  if (!rgb) return undefined;
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4]);
  if (alpha < 0.5) return undefined;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((channel) => Math.min(255, channel)) as Rgb;
}

export function toHex([red, green, blue]: Rgb): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((channel, index) => channel + ((to[index] ?? channel) - channel) * amount) as Rgb;
}

export function relativeLuminance([red, green, blue]: Rgb): number {
  const channel = (value: number) => {
    const normalized = Math.min(255, Math.max(0, value)) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function chroma([red, green, blue]: Rgb): number {
  return (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
}

// ---------------------------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------------------------

type Category = 'sans' | 'serif';

interface CatalogFont {
  /** Static @fontsource package; static files embed as clean TrueType in PDFs (variable fonts become Type 3). */
  pkg: string;
  category: Category;
}

const font = (name: string, category: Category): CatalogFont => ({ pkg: `@fontsource/${name}`, category });

const CATALOG: Record<string, CatalogFont> = {
  inter: font('inter', 'sans'), manrope: font('manrope', 'sans'), dmsans: font('dm-sans', 'sans'), ibmplexsans: font('ibm-plex-sans', 'sans'),
  sourcesans3: font('source-sans-3', 'sans'), worksans: font('work-sans', 'sans'), spacegrotesk: font('space-grotesk', 'sans'),
  montserrat: font('montserrat', 'sans'), opensans: font('open-sans', 'sans'), roboto: font('roboto', 'sans'), nunitosans: font('nunito-sans', 'sans'),
  plusjakartasans: font('plus-jakarta-sans', 'sans'), figtree: font('figtree', 'sans'), outfit: font('outfit', 'sans'), lato: font('lato', 'sans'),
  poppins: font('poppins', 'sans'),
  fraunces: font('fraunces', 'serif'), sourceserif4: font('source-serif-4', 'serif'), newsreader: font('newsreader', 'serif'),
  playfairdisplay: font('playfair-display', 'serif'), lora: font('lora', 'serif'), ebgaramond: font('eb-garamond', 'serif'),
  merriweather: font('merriweather', 'serif'), librecaslontext: font('libre-caslon-text', 'serif'), librebaskerville: font('libre-baskerville', 'serif'),
};

/** Weights embedded for every family (when the family has them) and the italic weights. */
const EMBED_WEIGHTS = [400, 500, 600, 700];
const EMBED_ITALICS = [400, 600];

/** Commercial and system fonts mapped to the closest bundled open-source equivalent. */
const ALIASES: Record<string, string> = {
  helvetica: 'inter', helveticaneue: 'inter', arial: 'inter', neuehaasgrotesk: 'inter', neuehaasunica: 'inter', haasgrotesk: 'inter',
  akzidenzgrotesk: 'inter', suisse: 'inter', suisseintl: 'inter', sohne: 'inter', graphik: 'inter', aktivgrotesk: 'inter',
  gtamerica: 'inter', calibre: 'inter', sfpro: 'inter', sfprodisplay: 'inter', sfprotext: 'inter', applesystem: 'inter',
  blinkmacsystemfont: 'inter', systemui: 'inter', segoeui: 'inter', geist: 'inter', geistsans: 'inter', universe: 'inter', univers: 'inter',
  frutiger: 'sourcesans3', myriad: 'sourcesans3', myriadpro: 'sourcesans3', sourcesanspro: 'sourcesans3', calibri: 'sourcesans3',
  verdana: 'opensans', tahoma: 'opensans', trebuchetms: 'opensans', notosans: 'opensans', segoe: 'opensans',
  circular: 'dmsans', circularstd: 'dmsans', circularxx: 'dmsans', basier: 'dmsans', basiercircle: 'dmsans', ttcommons: 'dmsans', ttcommonspro: 'dmsans',
  avenir: 'figtree', avenirnext: 'figtree', proximanova: 'figtree', museosans: 'nunitosans', nunito: 'nunitosans',
  futura: 'outfit', futurapt: 'outfit', brandongrotesque: 'outfit', euclid: 'outfit', euclidcirculara: 'outfit', sofiapro: 'outfit', gilroy: 'plusjakartasans',
  aeonik: 'manrope', satoshi: 'manrope', generalsans: 'manrope', gotham: 'montserrat', gothamrounded: 'montserrat', ibmplex: 'ibmplexsans',
  georgia: 'sourceserif4', times: 'sourceserif4', timesnewroman: 'sourceserif4', tiempos: 'newsreader', tiemposheadline: 'newsreader',
  tiempostext: 'sourceserif4', publico: 'newsreader', publicoheadline: 'newsreader', lyon: 'newsreader', lyontext: 'sourceserif4',
  freighttext: 'sourceserif4', freighttextpro: 'sourceserif4', freightdisplay: 'playfairdisplay', sourceserifpro: 'sourceserif4',
  canela: 'fraunces', ogg: 'fraunces', editorialnew: 'fraunces', gtsectra: 'fraunces', recoleta: 'fraunces', cooper: 'fraunces',
  domaine: 'playfairdisplay', domainedisplay: 'playfairdisplay', didot: 'playfairdisplay', bodoni: 'playfairdisplay', ivardisplay: 'playfairdisplay',
  caslon: 'librecaslontext', adobecaslon: 'librecaslontext', librecaslon: 'librecaslontext', librecaslondisplay: 'librecaslontext',
  garamond: 'ebgaramond', adobegaramond: 'ebgaramond', garamondpremier: 'ebgaramond', cormorant: 'ebgaramond', cormorantgaramond: 'ebgaramond',
  baskerville: 'librebaskerville', mrseaves: 'librebaskerville', charter: 'sourceserif4', iowan: 'sourceserif4', iowanoldstyle: 'sourceserif4',
};

const DROPPABLE_SUFFIXES = ['variable', 'var', 'web', 'webfont', 'std', 'pro', 'display', 'text', 'headline', 'regular', 'book', 'medium', 'bold', 'vf'];

export interface ResolvedFont {
  key: string;
  family: string;
  category: Category;
  /** The client font this was matched from, when one was recognised. */
  matchedFrom?: string;
}

/** Resolves a CSS font-family stack (as computed on the client's website) to a bundled font. */
export function resolveFontStack(stack: string | undefined): ResolvedFont | undefined {
  if (!stack) return undefined;
  let genericCategory: Category | undefined;
  for (const raw of stack.split(',')) {
    const original = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!original) continue;
    const lower = original.toLowerCase();
    if (lower === 'serif') { genericCategory ??= 'serif'; continue; }
    if (['sans-serif', 'system-ui', '-apple-system', 'ui-sans-serif'].includes(lower)) { genericCategory ??= 'sans'; continue; }
    if (/fallback/i.test(original) || ['monospace', 'cursive', 'fantasy', 'emoji', 'math'].includes(lower)) continue;
    const key = lookupFont(original);
    if (key) return { key, family: familyName(key), category: (CATALOG[key] as CatalogFont).category, matchedFrom: original };
  }
  if (!genericCategory) return undefined;
  const key = genericCategory === 'serif' ? 'sourceserif4' : 'inter';
  return { key, family: familyName(key), category: (CATALOG[key] as CatalogFont).category };
}

function lookupFont(name: string): string | undefined {
  // Next.js and other build tools mangle names, e.g. "__Inter_d65c78" or "Inter var".
  let normalized = name.toLowerCase().replace(/^_+/, '').replace(/_[0-9a-f]{5,8}$/i, '').replace(/[^a-z0-9]/g, '');
  for (let attempt = 0; attempt < 4 && normalized; attempt += 1) {
    if (CATALOG[normalized]) return normalized;
    if (ALIASES[normalized]) return ALIASES[normalized];
    const suffix = DROPPABLE_SUFFIXES.find((candidate) => normalized.endsWith(candidate) && normalized.length > candidate.length + 2);
    if (!suffix) break;
    normalized = normalized.slice(0, -suffix.length);
  }
  return undefined;
}

export interface Typography {
  display: ResolvedFont;
  text: ResolvedFont;
  /** @font-face rules with the files embedded as data URIs; self-contained for PDF and HTML. */
  css: string;
  displayStack: string;
  textStack: string;
  displayWeight: number;
  displayItalicAvailable: boolean;
  displayTracking: string;
  /** Short human-readable description for the operator, e.g. "Fraunces + Inter (matched from Inter)". */
  summary: string;
}

const DEFAULT_DISPLAY = 'fraunces';
const DEFAULT_TEXT = 'inter';

export function chooseTypography(brand: Pick<BrandProfile, 'fontFamily'> & { headingFontFamily?: string } | undefined): Typography {
  const heading = resolveFontStack(brand?.headingFontFamily);
  const body = resolveFontStack(brand?.fontFamily);
  const fallback = (key: string): ResolvedFont => ({ key, family: familyName(key), category: (CATALOG[key] as CatalogFont).category });
  let display: ResolvedFont;
  let text: ResolvedFont;
  if (heading?.matchedFrom || body?.matchedFrom) {
    text = body?.matchedFrom ? body : heading?.category === 'sans' && heading.matchedFrom ? heading : fallback(DEFAULT_TEXT);
    display = heading?.matchedFrom ? heading : text;
  } else {
    // Nothing recognisable on the website: use the house editorial pairing.
    display = fallback(DEFAULT_DISPLAY);
    text = fallback(DEFAULT_TEXT);
  }
  const keys = [...new Set([display.key, text.key])];
  const css = keys.map((key) => fontFaceCss(key)).join('\n');
  const genericFor = (font: ResolvedFont) => font.category === 'serif' ? 'Georgia, serif' : 'Arial, sans-serif';
  const matched = [display.matchedFrom, text.matchedFrom].filter(Boolean);
  return {
    display,
    text,
    css,
    displayStack: `'${display.family}', ${genericFor(display)}`,
    textStack: `'${text.family}', ${genericFor(text)}`,
    displayWeight: display.category === 'serif' ? 400 : nearestWeight(display.key, 600),
    displayItalicAvailable: hasItalic(display.key),
    displayTracking: display.category === 'serif' ? '-0.012em' : '-0.028em',
    summary: `${displayName(display)}${display.key === text.key ? '' : ` + ${displayName(text)}`}${matched.length ? ` (matched from ${[...new Set(matched)].join(', ')})` : ' (house pairing)'}`,
  };
}

function displayName(font: ResolvedFont): string { return font.family; }

function nearestWeight(key: string, preferred: number): number {
  const available = EMBED_WEIGHTS.filter((weight) => existsSync(path.join(packageDir((CATALOG[key] as CatalogFont).pkg), `${weight}.css`)));
  return available.reduce((best, weight) => Math.abs(weight - preferred) < Math.abs(best - preferred) ? weight : best, available[0] ?? 400);
}

const familyNames = new Map<string, string>();

/** The CSS family name declared by the bundled files, e.g. "Source Serif 4". */
export function familyName(key: string): string {
  let name = familyNames.get(key);
  if (!name) {
    const font = CATALOG[key];
    if (!font) throw new Error(`Unknown font ${key}`);
    const css = readFileSync(path.join(packageDir(font.pkg), '400.css'), 'utf8');
    name = css.match(/font-family:\s*'([^']+)'/)?.[1] ?? key;
    familyNames.set(key, name);
  }
  return name;
}

const requireFromHere = createRequire(import.meta.url);
const packageDirs = new Map<string, string>();
const faceCache = new Map<string, string>();

function packageDir(pkg: string): string {
  let dir = packageDirs.get(pkg);
  if (!dir) {
    dir = path.dirname(requireFromHere.resolve(pkg));
    packageDirs.set(pkg, dir);
  }
  return dir;
}

function hasItalic(key: string): boolean {
  const font = CATALOG[key];
  return Boolean(font) && existsSync(path.join(packageDir((font as CatalogFont).pkg), '400-italic.css'));
}

/** Builds @font-face rules for the latin and latin-ext subsets with the woff2 files inlined. */
export function fontFaceCss(key: string): string {
  const cached = faceCache.get(key);
  if (cached !== undefined) return cached;
  const font = CATALOG[key];
  if (!font) throw new Error(`Unknown font ${key}`);
  const dir = packageDir(font.pkg);
  const sheets = [...EMBED_WEIGHTS.map((weight) => `${weight}.css`), ...EMBED_ITALICS.map((weight) => `${weight}-italic.css`)];
  const rules: string[] = [];
  for (const sheet of sheets) {
    const file = path.join(dir, sheet);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const block of source.match(/@font-face\s*{[^}]*}/g) ?? []) {
      const url = block.match(/url\(\.\/files\/([^)]+?\.woff2)\)/)?.[1];
      if (!url || !/-latin-(?:ext-)?\d{3}-/.test(url)) continue;
      const data = readFileSync(path.join(dir, 'files', url)).toString('base64');
      rules.push(block
        .replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${data}) format('woff2');`)
        .replace(/font-display:[^;]+;/, 'font-display: block;'));
    }
  }
  const css = rules.join('\n');
  faceCache.set(key, css);
  return css;
}

/** All bundled font keys; used by tests to make sure every package resolves. */
export function catalogKeys(): string[] { return Object.keys(CATALOG); }

// ---------------------------------------------------------------------------------------------
// Shared design tokens and motif
// ---------------------------------------------------------------------------------------------

export interface DesignSystem {
  palette: Palette;
  type: Typography;
  /** CSS custom properties for every template. */
  cssVariables: string;
}

export function designSystemFor(brand: (BrandProfile & { headingFontFamily?: string }) | undefined, fallbackColor?: string): DesignSystem {
  const palette = derivePalette(brand?.primaryColor, fallbackColor);
  const type = chooseTypography(brand);
  const cssVariables = `:root{${Object.entries({
    '--accent': palette.accent, '--accent-text': palette.accentText, '--on-accent': palette.onAccent, '--accent-on-dark': palette.accentOnDark,
    '--dark': palette.dark, '--on-dark': palette.onDark, '--muted-on-dark': palette.mutedOnDark, '--rule-on-dark': palette.ruleOnDark,
    '--paper': palette.paper, '--paper-2': palette.paper2, '--ink': palette.ink, '--muted': palette.muted, '--rule': palette.rule, '--tint': palette.tint,
    '--font-display': type.displayStack, '--font-text': type.textStack, '--display-weight': String(type.displayWeight), '--display-tracking': type.displayTracking,
  }).map(([name, value]) => `${name}:${value}`).join(';')}}`;
  return { palette, type, cssVariables };
}

/**
 * A deterministic "recording" waveform used as the campaign motif: the same title always
 * produces the same shape, so the guide, carousel and clips share one mark.
 */
export function waveformSvg(seedText: string, options: { bars?: number; width: number; height: number; color: string; opacity?: number }): string {
  const bars = options.bars ?? 64;
  let seed = [...seedText].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 2166136261) || 1;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const raw = Array.from({ length: bars }, () => random());
  const smooth = raw.map((_, index) => {
    const window = raw.slice(Math.max(0, index - 2), index + 3);
    const envelope = Math.sin(Math.PI * (index + 0.5) / bars) ** 0.6;
    return (0.25 + 0.75 * (window.reduce((sum, value) => sum + value, 0) / window.length)) * envelope;
  });
  const gap = options.width / bars;
  const barWidth = Math.max(1, gap * 0.42);
  const rects = smooth.map((value, index) => {
    const height = Math.max(barWidth, value * options.height);
    return `<rect x="${(index * gap + (gap - barWidth) / 2).toFixed(2)}" y="${((options.height - height) / 2).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${height.toFixed(2)}" rx="${(barWidth / 2).toFixed(2)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${options.width} ${options.height}" width="${options.width}" height="${options.height}" aria-hidden="true"><g fill="${options.color}" fill-opacity="${options.opacity ?? 1}">${rects}</g></svg>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character);
}

/** "https://www.northstar.com/path" -> "northstar.com" */
export function displayDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
}

/** Marks a quote that starts or ends mid-sentence with an ellipsis instead of altering the speaker's words. */
export function displayQuote(quote: string): string {
  let text = quote.trim();
  // Strip outer marks only when they wrap the whole quote; a leading mark may open quoted speech inside it.
  if (/^["“]/.test(text) && /["”]$/.test(text)) text = text.replace(/^["“]+|["”]+$/g, '');
  // Speech quoted inside the quote becomes single curly quotes, so the outer marks stay balanced.
  text = text.replace(/"([^"]+)"/g, '‘$1’').replace(/"/g, '');
  if (/^[a-z]/.test(text)) text = `…${text}`;
  if (!/[.!?…]$/.test(text)) text = `${text}…`;
  return text;
}
