import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { renderArtifacts } from '../src/render.js';
import { intakeSchema, type Project } from '../src/types.js';

const browserAvailable = await chromium.launch().then((browser) => browser.close().then(() => true), () => false);

describe('guide rendering', () => {
  it.skipIf(!browserAvailable)('flows an overlong section onto a continuation page instead of failing', async () => {
    const paragraph = 'A pricing change is only as strong as the reason the account team can repeat when a client pushes back. '.repeat(6);
    const now = new Date().toISOString();
    const project: Project = {
      id: `render-test-${Date.now()}`, status: 'rendering', progress: 88, createdAt: now, updatedAt: now, transcript: '', reviewToken: 'token', events: [], mode: 'demo',
      intake: intakeSchema.parse({ companyName: 'Long Form Ltd', contactName: 'Ada', contactEmail: 'ada@example.com', website: 'https://example.com', sourceType: 'webinar', audience: 'Partners', offer: 'Advisory', callToAction: 'Reply to start' }),
      brand: { title: 'Long Form', description: '', logoUrl: '', primaryColor: '#1F4D3A', backgroundColor: '#fff', textColor: '#111', fontFamily: 'Arial', borderRadius: '4px', voiceSample: '', sourceUrl: 'https://example.com' },
      bundle: {
        campaignAngle: 'Angle', title: 'Guide', subtitle: 'Subtitle', executiveSummary: 'Summary',
        sections: Array.from({ length: 4 }, (_, index) => ({ eyebrow: `P${index}`, title: `Section ${index}`, body: Array.from({ length: index === 1 ? 9 : 2 }, () => paragraph), pullQuote: index === 1 ? 'A quote worth keeping.' : undefined, sourceTimestamp: undefined })),
        actionChecklist: ['One', 'Two', 'Three', 'Four'],
        linkedinPosts: Array.from({ length: 8 }, () => ({ hook: 'Hook', body: 'Body', cta: 'CTA' })),
        emails: Array.from({ length: 3 }, () => ({ subject: 'S', preview: 'P', body: 'B', cta: 'C' })),
        landingPage: { eyebrow: 'E', headline: 'H', subheadline: 'S', bullets: ['A', 'B', 'C'], formHeading: 'F', buttonLabel: 'Go' },
        sourceReferences: [],
      },
    };
    const artifacts = await renderArtifacts(project);
    const pdf = await readFile(artifacts.pdf, 'latin1');
    const pages = pdf.match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    // cover, intro, contents, 4 sections, checklist, CTA = 9 pages without flowing.
    expect(pages).toBeGreaterThan(9);
  }, 60_000);
});
