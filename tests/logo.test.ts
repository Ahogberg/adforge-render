import { describe, expect, it } from 'vitest';
import { loadLogo } from '../src/brand.js';

describe('logo loading', () => {
  it('passes through image data URIs and rejects other data', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(await loadLogo(png)).toBe(png);
    expect(await loadLogo('data:text/html;base64,PGgxPmhpPC9oMT4=')).toBe('');
  });

  it('never fetches from private or local addresses', async () => {
    expect(await loadLogo('http://127.0.0.1/logo.png')).toBe('');
    expect(await loadLogo('http://localhost/logo.png')).toBe('');
    expect(await loadLogo('file:///etc/passwd')).toBe('');
    expect(await loadLogo('')).toBe('');
  });
});
