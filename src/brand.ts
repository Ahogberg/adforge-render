import { chromium, type Browser } from 'playwright';
import { pickBrandColor } from './color.js';
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
    // tsx (npm run dev) wraps named inner functions in __name(); define it in the page as a no-op.
    await page.evaluate('globalThis.__name ??= (fn) => fn');
    const scraped = await page.evaluate(() => {
      const first = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);
      const style = (element: Element | null): CSSStyleDeclaration | undefined => element ? getComputedStyle(element) : undefined;
      const wide = (element: Element) => element.getBoundingClientRect().width >= 48;
      const visible = <T extends Element>(selector: string): T | undefined => Array.from(document.querySelectorAll<T>(selector)).find(wide);
      const transparent = (color: string) => !color || color === 'transparent' || /^rgba\(.*,\s*0(\.0+)?\)$/.test(color);
      const backgroundBehind = (element: Element): string => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (!transparent(color)) return color;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const svgDataUri = (svg: SVGSVGElement): string => {
        const clone = svg.cloneNode(true) as SVGSVGElement;
        const box = svg.getBoundingClientRect();
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(box.width)));
        if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(box.height)));
        const markup = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, getComputedStyle(svg).color);
        // Sprite references (<use href="#…">) point outside the clone and would render blank.
        return markup.length > 200_000 || /<use[\s>]/.test(markup) ? '' : `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(markup)))}`;
      };

      const logoImage = visible<HTMLImageElement>('img[class*="logo" i], img[alt*="logo" i], [class*="logo" i] img, [id*="logo" i] img');
      const logoSvg = visible<SVGSVGElement>('svg[class*="logo" i], [class*="logo" i] svg, [id*="logo" i] svg');
      const headerImage = visible<HTMLImageElement>('header img, nav img');
      const headerSvg = visible<SVGSVGElement>('header a svg, nav a svg');
      const logoElement = logoImage ?? logoSvg ?? headerImage ?? headerSvg;
      const logoUrl = !logoElement ? '' : logoElement instanceof HTMLImageElement ? logoElement.currentSrc || logoElement.src : svgDataUri(logoElement as SVGSVGElement);

      const buttons = Array.from(document.querySelectorAll<HTMLElement>('a[class*="button" i], a[class*="btn" i], a[class*="cta" i], button')).filter(wide).slice(0, 12);
      const heading = first<HTMLElement>('main h1, h1');
      const bodyStyle = getComputedStyle(document.body);
      return {
        title: document.title,
        description: first<HTMLMetaElement>('meta[name="description"]')?.content || '',
        logoUrl,
        logoBackground: logoElement ? backgroundBehind(logoElement) : '',
        colorCandidates: [
          ...buttons.map((button) => getComputedStyle(button).backgroundColor),
          first<HTMLMetaElement>('meta[name="theme-color"]')?.content,
          style(heading)?.color,
          ...Array.from(document.querySelectorAll<HTMLElement>('header a, nav a')).slice(0, 12).map((link) => getComputedStyle(link).color),
        ],
        backgroundColor: transparent(bodyStyle.backgroundColor) ? '#ffffff' : bodyStyle.backgroundColor,
        textColor: bodyStyle.color || '#171717',
        fontFamily: bodyStyle.fontFamily || 'Arial, sans-serif',
        borderRadius: style(buttons[0] ?? null)?.borderRadius || '4px',
        voiceSample: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 4_000),
        sourceUrl: window.location.href,
      };
    });
    const { colorCandidates, ...profile } = scraped;
    return { ...profile, primaryColor: pickBrandColor(colorCandidates, fallbackColor) };
  } finally {
    await context.close();
  }
}

const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const MAX_LOGO_BYTES = 1_500_000;

/**
 * Fetches a scraped logo and returns it as a data URI so rendering never reaches the network.
 * Every redirect hop is re-validated against private addresses. Returns '' when the logo is unusable.
 */
export async function loadLogo(logoUrl: string | undefined): Promise<string> {
  if (!logoUrl) return '';
  try {
    if (logoUrl.startsWith('data:')) {
      const type = logoUrl.slice(5, logoUrl.search(/[;,]/)).toLowerCase();
      return LOGO_TYPES.has(type) && logoUrl.length <= MAX_LOGO_BYTES * 1.4 ? logoUrl : '';
    }
    let url = await assertPublicUrl(logoUrl);
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'image/*' } });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = await assertPublicUrl(new URL(location, url).toString());
        continue;
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!response.ok || !LOGO_TYPES.has(type) || Number(response.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES) return '';
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > MAX_LOGO_BYTES ? '' : `data:${type};base64,${bytes.toString('base64')}`;
    }
  } catch {
    // An unreachable or unsafe logo falls back to the typographic company name.
  }
  return '';
}
