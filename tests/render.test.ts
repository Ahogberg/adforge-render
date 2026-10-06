import { mkdir, readFile, stat } from 'node:fs/promises';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { generateCampaign } from '../src/ai.js';
import { ffmpegAvailable, probe, runFfmpeg } from '../src/media.js';
import { renderArtifacts } from '../src/render.js';
import { config } from '../src/config.js';
import { intakeSchema, type BrandProfile, type Project } from '../src/types.js';

const browserAvailable = await chromium.launch().then((browser) => browser.close().then(() => true), () => false);
const videoAvailable = browserAvailable && await ffmpegAvailable();

const intake = intakeSchema.parse({ companyName: 'Long Form Ltd', contactName: 'Ada', contactEmail: 'ada@example.com', website: 'https://www.long-form.example', sourceType: 'webinar', audience: 'Partners at advisory firms', offer: 'Advisory', callToAction: 'Reply to start', expertName: 'Ada Lovelace, Partner' });
const brand: BrandProfile = { title: 'Long Form', description: '', logoUrl: '', primaryColor: '#1F4D3A', backgroundColor: '#fff', textColor: '#111', fontFamily: 'Figtree, sans-serif', headingFontFamily: '"Libre Caslon Text", serif', borderRadius: '4px', voiceSample: '', sourceUrl: 'https://example.com' };

function project(id: string, extra: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return { id: `${id}-${Date.now()}`, status: 'rendering', progress: 88, createdAt: now, updatedAt: now, transcript: '', reviewToken: 'token', events: [], mode: 'demo', intake, brand, ...extra };
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('guide rendering', () => {
  it.skipIf(!browserAvailable)('flows an overlong section onto a continuation page instead of failing', async () => {
    const paragraph = 'A pricing change is only as strong as the reason the account team can repeat when a client pushes back. '.repeat(6);
    const artifacts = await renderArtifacts(project('render-overflow', {
      bundle: {
        campaignAngle: 'Angle', title: 'Guide', subtitle: 'Subtitle', executiveSummary: 'Summary',
        sections: Array.from({ length: 4 }, (_, index) => ({ eyebrow: `P${index}`, title: `Section ${index}`, body: Array.from({ length: index === 1 ? 9 : 2 }, () => paragraph), pullQuote: index === 1 ? 'A quote worth keeping.' : undefined, sourceTimestamp: undefined })),
        actionChecklist: ['One', 'Two', 'Three', 'Four'],
        linkedinPosts: Array.from({ length: 8 }, () => ({ hook: 'Hook', body: 'Body', cta: 'CTA' })),
        emails: Array.from({ length: 3 }, () => ({ subject: 'S', preview: 'P', body: 'B', cta: 'C' })),
        landingPage: { eyebrow: 'E', headline: 'H', subheadline: 'S', bullets: ['A', 'B', 'C'], formHeading: 'F', buttonLabel: 'Go' },
        sourceReferences: [],
      },
    }), { skipVideo: true });
    const pdf = await readFile(artifacts.pdf, 'latin1');
    const pages = pdf.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    // cover, introduction, 4 sections, checklist, back cover = 8 pages without flowing.
    expect(pages).toBeGreaterThan(8);
  }, 60_000);

  it.skipIf(!browserAvailable)('renders every layout, the carousel, and one visual per post in the client design system', async () => {
    const bundle = await generateCampaign({ intake, brand, transcript: '' });
    expect(new Set(bundle.sections.map((section) => section.layout))).toEqual(new Set(['essay', 'stat', 'framework', 'comparison']));
    const artifacts = await renderArtifacts(project('render-layouts', { bundle }), { skipVideo: true });
    const pdf = await readFile(artifacts.pdf, 'latin1');
    // Static fonts embed as TrueType; variable fonts would become blurry Type 3 glyphs.
    expect(pdf).toContain('/CIDFontType2');
    expect(pdf).not.toContain('/Subtype /Type3');
    expect(artifacts.designSummary).toContain('Libre Caslon Text + Figtree');
    expect(artifacts.carouselSlides).toHaveLength((bundle.carousel?.slides.length ?? 0) + 2);
    expect(artifacts.postCards).toHaveLength(8);
    for (const file of [...(artifacts.carouselSlides ?? []), ...(artifacts.postCards ?? [])]) {
      expect(pngSize(await readFile(file))).toEqual({ width: 1080, height: 1350 });
    }
    expect((await stat(artifacts.carouselPdf as string)).size).toBeGreaterThan(10_000);
    const landing = await readFile(artifacts.landingPage, 'utf8');
    expect(landing).toContain('data:font/woff2;base64,');
    expect(artifacts.notes).toBeUndefined();
  }, 90_000);
});

describe('re-rendering a revision', () => {
  it.skipIf(!browserAvailable)('keeps the previous edition until the new one is complete, then points at the new files', async () => {
    const bundle = await generateCampaign({ intake, brand, transcript: '' });
    const base = project('render-revision', { bundle });
    const first = await renderArtifacts(base, { skipVideo: true });
    const broken = { ...base, bundle: { ...bundle, sections: [{ eyebrow: 'E', title: 'T', body: ['An argument that never ends. '.repeat(900)], layout: 'essay' as const }, ...bundle.sections.slice(1)] } };
    // A single block that can never fit one page fails the render; the first edition must survive it.
    await expect(renderArtifacts(broken, { skipVideo: true })).rejects.toThrow(/overflow/);
    expect((await stat(first.pdf)).size).toBeGreaterThan(0);
    const second = await renderArtifacts({ ...base, bundle: { ...bundle, title: 'Second edition' } }, { skipVideo: true });
    expect(second.pdf).toBe(first.pdf);
    for (const file of [second.pdf, second.carouselPdf as string, ...(second.postCards ?? [])]) expect((await stat(file)).size).toBeGreaterThan(0);
  }, 120_000);
});

describe('video rendering', () => {
  it.skipIf(!videoAvailable)('renders motion clips and captioned clips from an uploaded recording', async () => {
    const bundle = await generateCampaign({ intake, brand, transcript: '' });
    const transcript = [
      '[00:00] Speaker A: Most teams already have more expertise than they publish.',
      '[00:04] Speaker A: The problem is that the knowledge is trapped inside meetings, webinars, and individual conversations.',
      '[00:10] Speaker B: That changes what you do in the first hour after a session.',
      '[00:15] Speaker A: A summary tells people what was said.',
      '[00:18] Speaker A: An argument tells them what to do differently on Monday.',
    ].join('\n');
    const source = `${config.uploadDir}/render-test-source.mp4`;
    await mkdir(config.uploadDir, { recursive: true });
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
    const artifacts = await renderArtifacts(project('render-video', { bundle, transcript, sourceFile: source }));
    expect(artifacts.motionClips?.map((clip) => clip.kind)).toEqual(['stat', 'quote']);
    expect(artifacts.speakerClips?.length).toBeGreaterThanOrEqual(1);
    for (const clip of [...(artifacts.motionClips ?? []), ...(artifacts.speakerClips ?? [])]) {
      const info = await probe(clip.file);
      expect(info).toMatchObject({ hasVideo: true, hasAudio: true, width: 1080, height: 1350 });
      expect(info.durationSeconds).toBeGreaterThan(5);
      expect((await stat(clip.poster)).size).toBeGreaterThan(5_000);
    }
    const zip = await readFile(artifacts.deliveryZip, 'latin1');
    expect(zip).toContain('motion/figure-clip-01.mp4');
    expect(zip).not.toContain('.poster.jpg');
  }, 240_000);
});
