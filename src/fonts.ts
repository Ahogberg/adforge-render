import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

const FACES: Array<{ family: string; file: string; style: 'normal' | 'italic'; range: string }> = [
  { family: 'Inter', file: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', style: 'normal', range: LATIN },
  { family: 'Inter', file: '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2', style: 'normal', range: LATIN_EXT },
  { family: 'Source Serif', file: '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2', style: 'normal', range: LATIN },
  { family: 'Source Serif', file: '@fontsource-variable/source-serif-4/files/source-serif-4-latin-ext-wght-normal.woff2', style: 'normal', range: LATIN_EXT },
  { family: 'Source Serif', file: '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2', style: 'italic', range: LATIN },
  { family: 'Source Serif', file: '@fontsource-variable/source-serif-4/files/source-serif-4-latin-ext-wght-italic.woff2', style: 'italic', range: LATIN_EXT },
];

let cached: Promise<string> | undefined;

/**
 * Embedded @font-face rules so the guide and landing page render identically everywhere,
 * including the PDF renderer, without relying on system fonts or a font CDN.
 */
export function embeddedFontCss(): Promise<string> {
  cached ??= Promise.all(FACES.map(async (face) => {
    const data = await readFile(require.resolve(face.file));
    return `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:300 800;font-display:block;src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');unicode-range:${face.range}}`;
  })).then((rules) => rules.join(''));
  return cached;
}
