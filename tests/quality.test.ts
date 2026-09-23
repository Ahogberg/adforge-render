import { describe, expect, it } from 'vitest';
import { findUnverifiedQuotes, inspectCampaign } from '../src/quality.js';
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
    const bundle = validBundle();
    const report = inspectCampaign(bundle, 'Speaker: Source quote about the thesis.');
    expect(report.blockers).toEqual([]);
    expect(report.score).toBe(100);
  });

  it('blocks unresolved template tokens', () => {
    const bundle = validBundle();
    bundle.title = '{{unfinished}}';
    expect(inspectCampaign(bundle).blockers).toContain('No unresolved template tokens');
  });
});

describe('quote verification', () => {
  const transcript = [
    '[00:00] Speaker A: Most teams already have more expertise than they publish.',
    '[02:18] Speaker B: The useful shift is to treat a recording as source evidence, rather than finished content.',
  ].join('\n');

  it('passes quotes copied from the transcript, including light punctuation edits', () => {
    const bundle = validBundle();
    bundle.sourceReferences = [{ claim: 'Thesis', quote: 'The useful shift is to treat a recording as source evidence rather than finished content', speaker: 'B', timestamp: '02:18' }];
    bundle.sections[0]!.pullQuote = 'Most teams already have more expertise than they publish.';
    const report = inspectCampaign(bundle, transcript);
    expect(report.blockers).toEqual([]);
    expect(report.checks.find((check) => check.name === 'Quotes verified against source')?.status).toBe('pass');
  });

  it('blocks delivery when a quote is not in the source', () => {
    const bundle = validBundle();
    bundle.sections[1]!.pullQuote = 'Our clients grew revenue by 40 percent in one quarter.';
    const report = inspectCampaign(bundle, transcript);
    expect(report.blockers).toContain('Quotes verified against source');
    expect(findUnverifiedQuotes(bundle, transcript)).toContain('Our clients grew revenue by 40 percent in one quarter.');
  });
});
