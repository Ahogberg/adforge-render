import { describe, expect, it } from 'vitest';
import { catalogKeys, chooseTypography, contrast, derivePalette, displayQuote, familyName, fontFaceCss, parseColor, resolveFontStack, waveformSvg } from '../src/design.js';

describe('type matching', () => {
  it('recognises fonts as computed on real websites, including mangled build names', () => {
    expect(resolveFontStack('__Inter_d65c78, __Inter_Fallback_d65c78')?.key).toBe('inter');
    expect(resolveFontStack('"Libre Caslon Text", Georgia, serif')?.key).toBe('librecaslontext');
    expect(resolveFontStack('"Helvetica Neue", Arial, sans-serif')).toMatchObject({ key: 'inter', matchedFrom: 'Helvetica Neue' });
    expect(resolveFontStack('Tiempos Headline, serif')?.key).toBe('newsreader');
    expect(resolveFontStack('"Proxima Nova Bold", sans-serif')?.key).toBe('figtree');
    const generic = resolveFontStack('Some Custom Face, serif');
    expect(generic?.key).toBe('sourceserif4');
    expect(generic?.matchedFrom).toBeUndefined();
    expect(resolveFontStack('')).toBeUndefined();
  });

  it('pairs a serif heading with the body font and falls back to the house pairing', () => {
    expect(chooseTypography({ fontFamily: 'Figtree, sans-serif', headingFontFamily: '"Playfair Display", serif' })).toMatchObject({ display: { key: 'playfairdisplay' }, text: { key: 'figtree' }, displayWeight: 400 });
    const sans = chooseTypography({ fontFamily: 'Inter', headingFontFamily: 'Inter' });
    expect(sans.display.key).toBe('inter');
    expect(sans.displayWeight).toBe(600);
    expect(chooseTypography({ fontFamily: '' }).summary).toContain('house pairing');
  });

  it('bundles every catalogue font as embedded static latin files', () => {
    for (const key of catalogKeys()) {
      const css = fontFaceCss(key);
      expect(css, key).toContain(`font-family: '${familyName(key)}'`);
      expect(css, key).toContain('data:font/woff2;base64,');
      expect(css, key).not.toContain('./files/');
      expect(css, key).not.toMatch(/cyrillic|greek|vietnamese/);
    }
  });
});

describe('palette', () => {
  const samples = ['#1F4D3A', '#D09B45', '#F4E04D', '#0A1F44', '#E8664A', 'rgb(0, 0, 0)', '#FFFFFF', 'rgba(255,0,0,0.2)', '#7B61FF', 'not-a-colour'];
  it('always produces readable accent text and marks on dark backgrounds', () => {
    for (const sample of samples) {
      const palette = derivePalette(sample, '#1F4D3A');
      const rgb = (value: string) => parseColor(value) as [number, number, number];
      expect(contrast(rgb(palette.accentText), rgb(palette.paper)), sample).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(palette.accentOnDark), rgb(palette.dark)), sample).toBeGreaterThanOrEqual(4.2);
      expect(contrast(rgb(palette.onAccent), rgb(palette.accent)), sample).toBeGreaterThanOrEqual(3);
    }
  });

  it('ignores grey, white, and black "brand colours" that are really button defaults', () => {
    expect(derivePalette('#FFFFFF', '#1F4D3A').accent).toBe('#1F4D3A');
    expect(derivePalette('rgb(17, 17, 17)', '#D09B45').accent).toBe('#D09B45');
    expect(derivePalette('#777777', undefined).accent).toBe('#1F4D3A');
  });
});

describe('motif and copy helpers', () => {
  it('draws the same waveform for the same title', () => {
    const a = waveformSvg('The Repeatable Decision', { width: 600, height: 80, color: '#000' });
    expect(a).toBe(waveformSvg('The Repeatable Decision', { width: 600, height: 80, color: '#000' }));
    expect(a).not.toBe(waveformSvg('Another title', { width: 600, height: 80, color: '#000' }));
  });

  it('marks quote fragments with an ellipsis instead of changing the speaker’s words', () => {
    expect(displayQuote('treat a recording as source evidence')).toBe('…treat a recording as source evidence…');
    expect(displayQuote('“They wanted one clear way to decide.”')).toBe('They wanted one clear way to decide.');
  });
});
