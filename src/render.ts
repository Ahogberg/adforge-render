import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import Handlebars from 'handlebars';
import { chromium } from 'playwright';
import { config } from './config.js';
import type { Project } from './types.js';

export async function renderArtifacts(project: Project): Promise<NonNullable<Project['artifacts']>> {
  if (!project.bundle || !project.brand) throw new Error('Project content and brand profile are required before rendering');
  const directory = path.join(config.artifactDir, project.id);
  await mkdir(directory, { recursive: true });
  const view = {
    project,
    bundle: {
      ...project.bundle,
      sections: project.bundle.sections.map((section, index) => ({
        ...section,
        number: String(index + 1).padStart(2, '0'),
        folio: String(index + 4).padStart(2, '0'),
      })),
    },
    brand: {
      ...project.brand,
      accentColor: safeAccent(project.brand.primaryColor, project.intake.primaryColor),
      onAccentColor: readableText(safeAccent(project.brand.primaryColor, project.intake.primaryColor)),
    },
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

function normalizeTypography(value: string): string {
  return value
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\u00a0/g, ' ');
}

function safeAccent(primary: string, fallback: string): string {
  const candidate = parseRgb(primary);
  if (candidate && relativeLuminance(candidate) >= 0.16 && relativeLuminance(candidate) <= 0.78) return primary;
  const preferred = parseRgb(fallback);
  if (preferred && relativeLuminance(preferred) >= 0.16 && relativeLuminance(preferred) <= 0.78) return fallback;
  return '#1F4D3A';
}

function readableText(background: string): string {
  const rgb = parseRgb(background);
  return rgb && relativeLuminance(rgb) < 0.42 ? '#F7F3EA' : '#121414';
}

function parseRgb(value: string): [number, number, number] | undefined {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
  const rgb = value.trim().match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const channel = (value: number) => { const normalized = Math.min(255, value) / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; };
  return .2126 * channel(red) + .7152 * channel(green) + .0722 * channel(blue);
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
