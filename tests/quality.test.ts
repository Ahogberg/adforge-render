import { describe, expect, it } from 'vitest';
import { inspectCampaign } from '../src/quality.js';
import type { CampaignBundle } from '../src/types.js';

function validBundle(): CampaignBundle {
  return {
    campaignAngle: 'A decision framework',
    title: 'A practical guide',
    subtitle: 'For expert-led B2B teams',
    executiveSummary: 'A grounded editorial summary.',
    sections: Array.from({ length: 4 }, (_, index) => ({
      eyebrow: `Principle ${index + 1}`,
      title: `Section ${index + 1}`,
      body: ['A useful argument with practical detail.'],
      pullQuote: undefined,
      sourceTimestamp: undefined,
    })),
    actionChecklist: ['One', 'Two', 'Three', 'Four'],
    linkedinPosts: Array.from({ length: 8 }, (_, index) => ({ hook: `Hook ${index + 1}`, body: 'Body', cta: 'Reply' })),
    emails: Array.from({ length: 3 }, (_, index) => ({ subject: `Email ${index + 1}`, preview: 'Preview', body: 'Body', cta: 'Book' })),
    landingPage: { eyebrow: 'Guide', headline: 'Act on the idea', subheadline: 'A useful resource', bullets: ['One', 'Two', 'Three'], formHeading: 'Get it', buttonLabel: 'Send the guide' },
    sourceReferences: [{ claim: 'The thesis', quote: 'Source quote', speaker: 'Expert', timestamp: '00:42' }],
  };
}

describe('inspectCampaign', () => {
  it('passes a complete bundle', () => {
    const report = inspectCampaign(validBundle());
    expect(report.blockers).toEqual([]);
    expect(report.score).toBe(100);
  });

  it('blocks unresolved template tokens', () => {
    const bundle = validBundle();
    bundle.title = '{{unfinished}}';
    expect(inspectCampaign(bundle).blockers).toContain('No unresolved template tokens');
  });
});
