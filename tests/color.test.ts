import { describe, expect, it } from 'vitest';
import { brandPalette, contrastRatio, parseColor, pickBrandColor } from '../src/color.js';

const rgb = (value: string) => parseColor(value) as [number, number, number];

describe('brand colour', () => {
  it('reads computed rgb() and rgba() values and ignores transparent ones', () => {
    expect(parseColor('rgb(31, 77, 58)')).toEqual([31, 77, 58]);
    expect(parseColor('rgba(11, 37, 69, 0.9)')).toEqual([11, 37, 69]);
    expect(parseColor('rgba(0, 0, 0, 0)')).toBeUndefined();
    expect(parseColor('#abc')).toEqual([170, 187, 204]);
  });

  it('keeps dark brand colours instead of replacing them with the fallback', () => {
    expect(pickBrandColor(['rgb(31, 77, 58)'], '#E8C97A')).toBe('#1F4D3A');
    expect(pickBrandColor(['rgb(11, 37, 69)'], '#E8C97A')).toBe('#0B2545');
  });

  it('skips transparent buttons, greys, black and white before falling back', () => {
    expect(pickBrandColor(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)', 'rgb(17, 17, 17)', 'rgb(120, 120, 120)', 'rgb(242, 107, 33)'], '#E8C97A')).toBe('#F26B21');
    expect(pickBrandColor(['rgba(0, 0, 0, 0)', undefined], '#0B2545')).toBe('#0B2545');
  });

  it.each(['#1F4D3A', '#0B2545', '#E8C97A', '#F26B21', '#FFE600', '#7FDBFF', '#000000'])('derives readable colours from %s', (color) => {
    const palette = brandPalette(color);
    expect(contrastRatio(rgb(palette.accent), rgb(palette.tint))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(palette.accent), rgb('#FFFFFF'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(palette.onDeep), rgb(palette.deep))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(rgb(palette.deepAccent), rgb(palette.deep))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(palette.onButton), rgb(palette.button))).toBeGreaterThanOrEqual(4.5);
  });

  it('uses a dark brand colour itself for the cover panel', () => {
    expect(brandPalette('#1F4D3A').deep).toBe('#1F4D3A');
    expect(brandPalette('#E8C97A').deep).not.toBe('#E8C97A');
  });
});
