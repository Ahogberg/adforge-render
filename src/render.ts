import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import Handlebars from 'handlebars';
import { chromium } from 'playwright';
import { loadLogo } from './brand.js';
import { brandPalette, isDarkBackground, parseColor, pickBrandColor, toHex } from './color.js';
import { config } from './config.js';
import { embeddedFontCss } from './fonts.js';
import type { Project } from './types.js';

Handlebars.registerHelper('inc', (value: number) => value + 1);

const SOURCE_LABELS: Record<Project['intake']['sourceType'], string> = {
  webinar: 'A recorded webinar',
  podcast: 'A podcast conversation',
  workshop: 'A recorded workshop',
  keynote: 'A keynote talk',
  interview: 'An expert interview',
  presentation: 'A recorded presentation',
};

export async function renderArtifacts(project: Project): Promise<NonNullable<Project['artifacts']>> {
  if (!project.bundle || !project.brand) throw new Error('Project content and brand profile are required before rendering');
  const directory = path.join(config.artifactDir, project.id);
  await mkdir(directory, { recursive: true });
  // Profiles scraped before brand colours were normalised can hold transparent or grey values.
  const palette = brandPalette(pickBrandColor([project.brand.primaryColor], project.intake.primaryColor));
  const logoSrc = await loadLogo(project.brand.logoUrl);
  const logoBackground = parseColor(project.brand.logoBackground);
  const sectionCount = project.bundle.sections.length;
  const view = {
    project,
    bundle: {
      ...project.bundle,
      sections: project.bundle.sections.map((section, index) => ({
        ...section,
        number: String(index + 1).padStart(2, '0'),
        folio: String(index + 3).padStart(2, '0'),
      })),
    },
    palette,
    logo: {
      src: logoSrc,
      chip: Boolean(logoSrc) && isDarkBackground(project.brand.logoBackground),
      background: logoBackground ? toHex(logoBackground) : 'transparent',
    },
    fontCss: await embeddedFontCss(),
    edition: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date()),
    sourceLabel: [SOURCE_LABELS[project.intake.sourceType], project.intake.expertName ? `with ${project.intake.expertName}` : ''].filter(Boolean).join(' '),
    websiteHost: websiteHost(project.intake.website),
    closingFolio: String(sectionCount + 3).padStart(2, '0'),
  };
  const ebookTemplate = Handlebars.compile(await readFile(path.join(config.templateDir, 'ebook.hbs'), 'utf8'));
  const landingTemplate = Handlebars.compile(await readFile(path.join(config.templateDir, 'landing.hbs'), 'utf8'));
  const ebookHtml = normalizeTypography(ebookTemplate(view));
  const landingHtml = normalizeTypography(landingTemplate(view));
  const ebookHtmlPath = path.join(directory, 'premium-guide.html');
  const landingPath = path.join(directory, 'landing-page.html');
  const pdfPath = path.join(directory, 'premium-guide.pdf');
  await Promise.all([
    writeFile(ebookHtmlPath, ebookHtml, 'utf8'),
    writeFile(landingPath, landingHtml, 'utf8'),
    writeFile(path.join(directory, 'campaign.json'), JSON.stringify(project.bundle, null, 2), 'utf8'),
    writeFile(path.join(directory, 'linkedin-posts.md'), project.bundle.linkedinPosts.map((post, index) => `# Post ${index + 1}\n\n${post.hook}\n\n${post.body}\n\n${post.cta}`).join('\n\n---\n\n'), 'utf8'),
    writeFile(path.join(directory, 'email-sequence.md'), project.bundle.emails.map((email, index) => `# Email ${index + 1}: ${email.subject}\n\n**Preview:** ${email.preview}\n\n${email.body}\n\n**CTA:** ${email.cta}`).join('\n\n---\n\n'), 'utf8'),
    writeFile(path.join(directory, 'source-references.json'), JSON.stringify(project.bundle.sourceReferences, null, 2), 'utf8'),
  ]);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    await page.setContent(ebookHtml, { waitUntil: 'networkidle' });
    // Overflow is measured in real glyphs, so the embedded fonts must be active first.
    await page.evaluate('document.fonts.ready.then(() => true)');
    // tsx (npm run dev) wraps named inner functions in __name(); define it in the page as a no-op.
    await page.evaluate('globalThis.__name ??= (fn) => fn');
    await page.evaluate(replaceBrokenLogos);
    await page.evaluate(flowOverflowingSections);
    const overflows = await page.locator('.page').evaluateAll((pages) => pages.map((element, index) => ({ index, overflow: element.scrollHeight - element.clientHeight })).filter((item) => item.overflow > 2));
    if (overflows.length) throw new Error(`PDF layout overflow detected on pages: ${overflows.map((item) => item.index + 1).join(', ')}`);
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    await browser.close();
  }

  const zipPath = path.join(directory, 'afterword-delivery.zip');
  await zipDirectory(directory, zipPath);
  return { pdf: pdfPath, landingPage: landingPath, deliveryZip: zipPath };
}

/** Runs in the browser. A logo that fails to decode falls back to the typographic company name. */
export function replaceBrokenLogos(): void {
  document.querySelectorAll<HTMLImageElement>('.logo img').forEach((image) => {
    if (image.complete && image.naturalWidth > 0) return;
    const wordmark = document.createElement('div');
    wordmark.className = 'wordmark';
    wordmark.textContent = image.alt;
    image.closest('.logo')?.replaceWith(wordmark);
  });
}

/**
 * Runs in the browser. Lays out the fixed A4 pages:
 * - a page with data-split moves that element (the guide route, the closing call to action)
 *   onto its own page when the page overflows;
 * - an overflowing guide section moves its pull quote and trailing paragraphs onto a
 *   continuation page.
 * Then renumbers the numeric folios and the page references in the guide route.
 */
export function flowOverflowingSections(): void {
  const overflows = (element: Element) => element.scrollHeight - element.clientHeight > 2;
  for (let index = 0; index < document.querySelectorAll('.page').length; index += 1) {
    const page = document.querySelectorAll('.page')[index] as HTMLElement | undefined;
    if (!page || !overflows(page)) continue;
    const split = page.dataset.split ? page.querySelector(page.dataset.split) : null;
    if (split) {
      const folio = page.querySelector('.folio');
      const next = document.createElement('section');
      next.className = split.classList.contains('cta-band') ? 'page cta-page' : `${page.className} continued`;
      next.append(split);
      if (!split.querySelector('.folio') && folio) next.append(folio.cloneNode(true));
      if (!page.querySelector('.folio') && folio) page.append(folio.cloneNode(true));
      page.after(next);
      continue;
    }
    const body = page.querySelector('.body-copy');
    if (!body) continue;
    let continuation: HTMLElement | undefined;
    const continuationBody = () => {
      if (!continuation) {
        continuation = document.createElement('section');
        continuation.className = 'page content continued';
        const running = page.querySelector('.running')?.cloneNode(true);
        if (running) continuation.append(running);
        const heading = document.createElement('div');
        heading.className = 'eyebrow';
        heading.textContent = `${page.querySelector('h2')?.textContent ?? ''} (continued)`;
        continuation.append(heading);
        const nextBody = document.createElement('div');
        nextBody.className = 'body-copy';
        continuation.append(nextBody);
        const folio = page.querySelector('.folio')?.cloneNode(true);
        if (folio) continuation.append(folio);
        page.after(continuation);
      }
      return continuation.querySelector('.body-copy') as HTMLElement;
    };
    const quote = page.querySelector('blockquote');
    if (quote && overflows(page)) continuationBody().after(quote);
    while (overflows(page) && body.children.length > 1 && body.lastElementChild) {
      continuationBody().prepend(body.lastElementChild);
    }
  }
  const pages = Array.from(document.querySelectorAll('.page'));
  pages.forEach((page, index) => {
    const folio = page.querySelector('.folio b');
    if (folio && /^\d+$/.test(folio.textContent ?? '')) folio.textContent = String(index + 1).padStart(2, '0');
  });
  document.querySelectorAll<HTMLElement>('[data-route]').forEach((item) => {
    const target = pages.findIndex((page) => (page as HTMLElement).dataset.section === item.dataset.route);
    const label = item.querySelector('small');
    if (label && target >= 0) label.textContent = `p. ${String(target + 1).padStart(2, '0')}`;
  });
}

function normalizeTypography(value: string): string {
  return value
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\u00a0/g, ' ');
}

function websiteHost(website: string): string {
  try { return new URL(website).hostname.replace(/^www\./, ''); }
  catch { return website; }
}

async function zipDirectory(directory: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.glob('**/*', { cwd: directory, ignore: [path.basename(destination)] });
    void archive.finalize();
  });
}
