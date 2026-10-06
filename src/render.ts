import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import Handlebars from 'handlebars';
import { chromium, type Browser } from 'playwright';
import { config } from './config.js';
import { designSystemFor, displayDomain, displayQuote, waveformSvg, type DesignSystem } from './design.js';
import { renderMotionClips } from './motion.js';
import { renderSocialAssets } from './social.js';
import { renderSpeakerClips } from './speaker-clips.js';
import { effectiveLayout, type CampaignBundle, type CampaignSection, type Project, type ProjectArtifacts, type SectionLayout } from './types.js';

export interface RenderOptions {
  /** Progress callback, called before each rendering stage. */
  onStage?: (message: string) => Promise<unknown>;
  /** Skip video rendering (motion and speaker clips); used by tests and quick previews. */
  skipVideo?: boolean;
}

Handlebars.registerHelper('inc', (value: number) => value + 1);

export const ARROW_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export async function renderArtifacts(project: Project, options: RenderOptions = {}): Promise<ProjectArtifacts> {
  if (!project.bundle || !project.brand) throw new Error('Project content and brand profile are required before rendering');
  const stage = async (message: string) => { await options.onStage?.(message); };
  const finalDirectory = path.join(config.artifactDir, project.id);
  // Render the new edition beside the old one and swap only on success: the review page keeps
  // working during a revision, and a failed render never leaves the project pointing at deleted files.
  const directory = `${finalDirectory}.rendering-${randomUUID().slice(0, 8)}`;
  await mkdir(directory, { recursive: true });
  try {
    const artifacts = await renderInto(project, directory, stage, options);
    await rm(finalDirectory, { recursive: true, force: true });
    await rename(directory, finalDirectory);
    return relocate(artifacts, directory, finalDirectory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Rewrites every artifact path from the working directory to the final one. */
function relocate(artifacts: ProjectArtifacts, from: string, to: string): ProjectArtifacts {
  const move = (value: unknown): unknown => {
    if (typeof value === 'string') return value.startsWith(from) ? `${to}${value.slice(from.length)}` : value;
    if (Array.isArray(value)) return value.map(move);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, move(item)]));
    return value;
  };
  return move(artifacts) as ProjectArtifacts;
}

async function renderInto(project: Project, directory: string, stage: (message: string) => Promise<void>, options: RenderOptions): Promise<ProjectArtifacts> {
  if (!project.bundle || !project.brand) throw new Error('Project content and brand profile are required before rendering');
  const design = designSystemFor(project.brand, project.intake.primaryColor);
  const bundle = project.bundle;
  const notes: string[] = [];

  const ebookHtml = normalizeTypography(await renderTemplate('ebook.hbs', guideView(project, bundle, design)));
  const landingHtml = normalizeTypography(await renderTemplate('landing.hbs', landingView(project, bundle, design)));
  const pdfPath = path.join(directory, 'premium-guide.pdf');
  const landingPath = path.join(directory, 'landing-page.html');
  await Promise.all([
    writeFile(path.join(directory, 'premium-guide.html'), ebookHtml, 'utf8'),
    writeFile(landingPath, landingHtml, 'utf8'),
    writeFile(path.join(directory, 'campaign.json'), JSON.stringify(bundle, null, 2), 'utf8'),
    writeFile(path.join(directory, 'linkedin-posts.md'), bundle.linkedinPosts.map((post, index) => `# Post ${index + 1}\n\n${post.hook}\n\n${post.body}\n\n${post.cta}`).join('\n\n---\n\n'), 'utf8'),
    writeFile(path.join(directory, 'email-sequence.md'), bundle.emails.map((email, index) => `# Email ${index + 1}: ${email.subject}\n\n**Preview:** ${email.preview}\n\n${email.body}\n\n**CTA:** ${email.cta}`).join('\n\n---\n\n'), 'utf8'),
    writeFile(path.join(directory, 'source-references.json'), JSON.stringify(bundle.sourceReferences, null, 2), 'utf8'),
  ]);

  const artifacts: ProjectArtifacts = { pdf: pdfPath, landingPage: landingPath, deliveryZip: path.join(directory, 'afterword-delivery.zip'), designSummary: `${design.type.summary}; accent ${design.palette.accent}` };
  const browser = await chromium.launch({ headless: true });
  try {
    await stage('Rendering the premium guide');
    await renderGuidePdf(browser, ebookHtml, pdfPath);

    await stage('Rendering the LinkedIn carousel and post visuals');
    try {
      Object.assign(artifacts, await renderSocialAssets(browser, project, design, directory));
    } catch (error) {
      notes.push(`LinkedIn visuals could not be rendered: ${messageOf(error)}`);
    }

    if (!options.skipVideo) {
      await stage('Rendering motion clips');
      try {
        const motion = await renderMotionClips(browser, project, design, directory);
        artifacts.motionClips = motion.clips;
        notes.push(...motion.notes);
      } catch (error) {
        notes.push(`Motion clips could not be rendered: ${messageOf(error)}`);
      }
      await stage('Cutting captioned clips from the recording');
      try {
        const speaker = await renderSpeakerClips(browser, project, design, directory);
        artifacts.speakerClips = speaker.clips;
        notes.push(...speaker.notes);
      } catch (error) {
        notes.push(`Clips from the recording could not be rendered: ${messageOf(error)}`);
      }
    }
  } finally {
    await browser.close();
  }

  await stage('Packaging the delivery');
  if (notes.length) artifacts.notes = notes;
  await zipDirectory(directory, artifacts.deliveryZip);
  return artifacts;
}

async function renderGuidePdf(browser: Browser, html: string, pdfPath: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // tsx (npm run dev) wraps named inner functions in __name(); define it in the page as a no-op.
    await page.evaluate('globalThis.__name ??= (fn) => fn');
    await page.evaluate(flowOverflowingSections);
    const overflows = await page.locator('.page').evaluateAll((pages) => pages.map((element, index) => ({ index, overflow: element.scrollHeight - element.clientHeight })).filter((item) => item.overflow > 2));
    if (overflows.length) throw new Error(`PDF layout overflow detected on pages: ${overflows.map((item) => item.index + 1).join(', ')}`);
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    await page.close();
  }
}

const LAYOUT_LABELS: Record<SectionLayout, string> = { essay: 'Argument', framework: 'Framework', stat: 'Evidence', comparison: 'Comparison' };

function guideView(project: Project, bundle: CampaignBundle, design: DesignSystem) {
  const company = project.intake.companyName;
  const expert = project.intake.expertName.split(',')[0]?.trim() ?? '';
  const sourceType = project.intake.sourceType;
  return {
    project,
    bundle,
    design,
    company,
    domain: displayDomain(project.intake.website),
    issueLabel: new Date(project.createdAt || Date.now()).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    sourceLine: expert ? `From ${article(sourceType)} ${sourceType} with ${expert}` : `From an original ${sourceType}`,
    sourceSentence: `One ${sourceType}${expert ? ` with ${expert}` : ''}. Every quote and figure is checked against the recording and marked with the moment it was said.`,
    folioLabel: project.mode === 'demo' ? `${company} · Demo edition` : company,
    coverWave: waveformSvg(bundle.title, { width: 600, height: 100, bars: 84, color: design.palette.accentOnDark, opacity: 0.92 }),
    backWave: waveformSvg(bundle.title, { width: 600, height: 50, bars: 120, color: design.palette.onAccent, opacity: 0.7 }),
    arrowSvg: ARROW_SVG,
    sections: bundle.sections.map((section, index) => sectionView(section, index)),
  };
}

function sectionView(section: CampaignSection, index: number) {
  const layout = effectiveLayout(section);
  const hasFeature = layout !== 'essay';
  return {
    index,
    number: String(index + 1).padStart(2, '0'),
    eyebrow: section.eyebrow,
    title: section.title,
    layout,
    layoutLabel: layout === 'framework' && section.framework?.kind === 'sequence' ? 'Method' : LAYOUT_LABELS[layout],
    isStat: layout === 'stat',
    isFramework: layout === 'framework',
    isComparison: layout === 'comparison',
    // Feature pages open with one paragraph, then the feature, then the rest of the argument.
    leadParagraphs: hasFeature ? section.body.slice(0, 1) : section.body,
    restParagraphs: hasFeature ? section.body.slice(1) : [],
    pullQuote: section.pullQuote ? displayQuote(section.pullQuote) : undefined,
    sourceTimestamp: section.sourceTimestamp,
    stat: section.stat ? { ...section.stat, size: statSize(section.stat.value) } : undefined,
    framework: section.framework ? {
      name: section.framework.name,
      isSequence: section.framework.kind === 'sequence',
      columns: section.framework.items.length % 2 === 0 && section.framework.items.length <= 4 ? 2 : 3,
      items: section.framework.items.map((item, itemIndex) => ({ ...item, n: String(itemIndex + 1).padStart(2, '0') })),
    } : undefined,
    comparison: section.comparison,
  };
}

function landingView(project: Project, bundle: CampaignBundle, design: DesignSystem) {
  return {
    project,
    bundle,
    design,
    company: project.intake.companyName,
    domain: displayDomain(project.intake.website),
    wave: waveformSvg(bundle.title, { width: 600, height: 80, bars: 72, color: design.palette.accentOnDark, opacity: 0.9 }),
    sectionTitles: bundle.sections.map((section) => section.title),
  };
}

function statSize(value: string): number {
  const length = value.trim().length;
  if (length <= 3) return 96;
  if (length <= 5) return 82;
  if (length <= 8) return 64;
  if (length <= 11) return 50;
  return 40;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

async function renderTemplate(name: string, view: unknown): Promise<string> {
  let template = templateCache.get(name);
  if (!template) {
    template = Handlebars.compile(await readFile(path.join(config.templateDir, name), 'utf8'));
    if (process.env.NODE_ENV === 'production') templateCache.set(name, template);
  }
  return template(view);
}

/**
 * Runs in the browser. Moves the last flowable block (pull quote, paragraphs, then the feature)
 * of any overflowing page onto a continuation page, then numbers the folios and the contents.
 */
export function flowOverflowingSections(): void {
  const overflows = (element: Element) => element.scrollHeight - element.clientHeight > 2;
  for (let index = 0; index < document.querySelectorAll('.page').length; index += 1) {
    const page = document.querySelectorAll('.page')[index] as HTMLElement | undefined;
    if (!page || !overflows(page)) continue;
    const flow = page.querySelector('.flow');
    if (!flow) continue;
    let continuation: HTMLElement | undefined;
    const target = () => {
      if (!continuation) {
        continuation = document.createElement('section');
        continuation.className = `page content continued ${[...page.classList].filter((name) => name.startsWith('layout-')).join(' ')}`;
        continuation.dataset.title = page.dataset.title ?? '';
        const head = page.querySelector('.sec-head')?.cloneNode(true) as HTMLElement | undefined;
        if (head) {
          const label = head.querySelector('.label');
          if (label) label.textContent = `${page.dataset.title ?? ''} · continued`;
          continuation.append(head);
        }
        const nextFlow = document.createElement('div');
        nextFlow.className = 'flow';
        continuation.append(nextFlow);
        const folio = page.querySelector('.folio')?.cloneNode(true);
        if (folio) continuation.append(folio);
        page.after(continuation);
      }
      return continuation.querySelector('.flow') as HTMLElement;
    };
    while (overflows(page)) {
      const items = [...flow.querySelectorAll(':scope > [data-flow]')];
      const last = items[items.length - 1];
      if (items.length <= 1 || !last) break;
      target().prepend(last);
    }
  }
  const pages = [...document.querySelectorAll('.page')] as HTMLElement[];
  pages.forEach((page, index) => {
    const folio = page.querySelector('.folio b');
    if (folio && /^\d+$/.test(folio.textContent ?? '')) folio.textContent = String(index + 1).padStart(2, '0');
  });
  document.querySelectorAll<HTMLElement>('[data-toc]').forEach((row) => {
    const pageIndex = pages.findIndex((page) => page.dataset.sectionStart === row.dataset.toc);
    const number = row.querySelector('.pg');
    if (number && pageIndex >= 0) number.textContent = String(pageIndex + 1);
  });
}

function normalizeTypography(value: string): string {
  return value
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/ /g, ' ');
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function zipDirectory(directory: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    // Posters and working files are for the review page only; the client gets the finished assets.
    archive.glob('**/*', { cwd: directory, ignore: [path.basename(destination), '**/*.poster.jpg', '**/.work/**', 'premium-guide.html'] });
    void archive.finalize();
  });
}
