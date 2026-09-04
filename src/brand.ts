import { chromium, type Browser } from 'playwright';
import { isAllowedBrowserRequest, assertPublicUrl } from './security/url.js';
import type { BrandProfile } from './types.js';

let browserPromise: Promise<Browser> | undefined;

async function browser(): Promise<Browser> {
  browserPromise ??= chromium.launch({ headless: true });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const instance = await browserPromise;
  browserPromise = undefined;
  await instance.close();
}

export async function scrapeBrand(website: string, fallbackColor: string): Promise<BrandProfile> {
  const safeUrl = await assertPublicUrl(website);
  const context = await (await browser()).newContext({
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    viewport: { width: 1365, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      if (await isAllowedBrowserRequest(route.request().url())) await route.continue();
      else await route.abort('blockedbyclient');
    });
    await page.goto(safeUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    return await page.evaluate((primaryColor): BrandProfile => {
      const first = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);
      const style = (element: Element | null): CSSStyleDeclaration | undefined => element ? getComputedStyle(element) : undefined;
      const logo = first<HTMLImageElement>('header img, nav img, img[class*="logo" i], [class*="logo" i] img');
      const button = first<HTMLElement>('button, a[class*="button" i], a[class*="btn" i], a[class*="cta" i]');
      const heading = first<HTMLElement>('main h1, h1');
      const bodyStyle = getComputedStyle(document.body);
      const headingStyle = style(heading);
      const buttonStyle = style(button);
      const backgroundColor = bodyStyle.backgroundColor && bodyStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? bodyStyle.backgroundColor : '#ffffff';
      return {
        title: document.title,
        description: first<HTMLMetaElement>('meta[name="description"]')?.content || '',
        logoUrl: logo?.src || '',
        primaryColor: buttonStyle?.backgroundColor || headingStyle?.color || primaryColor,
        backgroundColor,
        textColor: bodyStyle.color || '#171717',
        fontFamily: bodyStyle.fontFamily || 'Arial, sans-serif',
        borderRadius: buttonStyle?.borderRadius || '4px',
        voiceSample: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 4_000),
        sourceUrl: window.location.href,
      };
    }, fallbackColor);
  } finally {
    await context.close();
  }
}
