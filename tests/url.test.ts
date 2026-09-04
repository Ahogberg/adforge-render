import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isAllowedBrowserRequest } from '../src/security/url.js';

describe('public URL validation', () => {
  it.each(['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.4', 'file:///etc/passwd'])(
    'rejects unsafe target %s',
    async (target) => expect(assertPublicUrl(target)).rejects.toThrow(),
  );

  it('allows embedded data resources in an already validated page', async () => {
    await expect(isAllowedBrowserRequest('data:image/png;base64,AA==')).resolves.toBe(true);
  });
});
