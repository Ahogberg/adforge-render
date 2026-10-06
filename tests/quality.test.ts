import { describe, expect, it } from 'vitest';
import { findDistantStats, findUnverifiedQuotes, findUnverifiedStats, inspectCampaign, parseTimestamp, parseTranscriptSegments } from '../src/quality.js';
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

function visualBundle(): CampaignBundle {
  const bundle = validBundle();
  bundle.sections[1] = { ...bundle.sections[1]!, layout: 'framework', framework: { name: 'The sequence', kind: 'sequence', items: [{ label: 'Name it', detail: 'One sentence.' }, { label: 'Prove it', detail: 'One moment.' }, { label: 'Act on it', detail: 'One step.' }] } };
  bundle.carousel = { title: 'The idea', slides: [{ heading: 'One', body: 'First idea.' }, { heading: 'Two', body: 'Second idea.' }, { heading: 'Three', body: 'Third idea.' }], closing: 'Get the guide.' };
  return bundle;
}

describe('inspectCampaign', () => {
  it('passes a complete bundle with visual layouts and a carousel', () => {
    const report = inspectCampaign(visualBundle(), 'Speaker: Source quote about the thesis.');
    expect(report.blockers).toEqual([]);
    expect(report.score).toBe(100);
  });

  it('only warns, never blocks, when a campaign predates layouts and carousels', () => {
    const report = inspectCampaign(validBundle(), 'Speaker: Source quote about the thesis.');
    expect(report.blockers).toEqual([]);
    expect(report.checks.find((check) => check.name === 'Visual guide layouts')?.status).toBe('warning');
    expect(report.checks.find((check) => check.name === 'LinkedIn carousel')?.status).toBe('warning');
  });

  it('does not mistake nested campaign objects for template syntax', () => {
    expect(inspectCampaign(visualBundle()).blockers).not.toContain('No unresolved template tokens');
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

describe('figure verification', () => {
  const transcript = [
    '[00:00] Speaker A: Most teams already have more expertise than they publish.',
    '[04:05] Speaker A: We went back through 40 client webinars from last year. 31 of them were never used again.',
    '[09:10] Speaker B: About forty percent of buyers asked for one thing.',
    '[22:00] Speaker B: Revenue grew 12% that year.',
  ].join('\n');
  const withStat = (value: string, sourceTimestamp: string): CampaignBundle => {
    const bundle = visualBundle();
    bundle.sections[2] = { ...bundle.sections[2]!, layout: 'stat', stat: { value, label: 'were never reused', context: 'One year of webinars', sourceTimestamp } };
    return bundle;
  };

  it('passes a figure said near its timestamp, in digits or in words', () => {
    expect(findUnverifiedStats(withStat('31 of 40', '04:05'), transcript)).toEqual([]);
    expect(findUnverifiedStats(withStat('40%', '09:10'), transcript)).toEqual([]);
    expect(inspectCampaign(withStat('31 of 40', '04:05'), transcript).blockers).not.toContain('Figures verified against source');
  });

  it('blocks a figure that was never said', () => {
    expect(findUnverifiedStats(withStat('35 of 40', '04:05'), transcript)).toEqual(['35 of 40']);
    expect(inspectCampaign(withStat('35 of 40', '04:05'), transcript).blockers).toContain('Figures verified against source');
  });

  it('warns, without blocking, when a real figure cites the wrong moment', () => {
    expect(findUnverifiedStats(withStat('12%', '04:05'), transcript)).toEqual([]);
    expect(findDistantStats(withStat('12%', '04:05'), transcript)).toEqual(['12%']);
    const report = inspectCampaign(withStat('12%', '04:05'), transcript);
    expect(report.blockers).not.toContain('Figures verified against source');
    expect(report.checks.find((check) => check.name === 'Figures verified against source')?.status).toBe('warning');
  });

  it('reads continuation lines and colons inside ordinary speech', () => {
    const wrapped = '[00:10] Maya Chen:\nWe looked at 31 of 40 teams.\n[00:30] We grew revenue 40% last year: here is how.';
    const segments = parseTranscriptSegments(wrapped);
    expect(segments[0]).toMatchObject({ speaker: 'Maya Chen', text: 'We looked at 31 of 40 teams.' });
    expect(segments[1]).toMatchObject({ speaker: '', text: 'We grew revenue 40% last year: here is how.' });
    expect(findUnverifiedStats(withStat('31 of 40', '00:10'), wrapped)).toEqual([]);
    expect(findDistantStats(withStat('40%', '00:30'), wrapped)).toEqual([]);
  });

  it('does not accept a number that only appears inside a larger one', () => {
    expect(findUnverifiedStats(withStat('2', '22:00'), transcript)).toEqual(['2']);
  });

  it('falls back to a plain essay page when a layout has no feature block', () => {
    const bundle = visualBundle();
    bundle.sections[0] = { ...bundle.sections[0]!, layout: 'stat', stat: undefined };
    expect(inspectCampaign(bundle, transcript).checks.find((check) => check.name === 'Figures verified against source')?.detail).toBe('The guide states no figures.');
  });

  it('parses timestamps and timestamped transcript lines', () => {
    expect(parseTimestamp('[18:40]')).toBe(1120);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('105:00')).toBe(6300);
    const segments = parseTranscriptSegments(transcript);
    expect(segments).toHaveLength(4);
    expect(segments[1]).toMatchObject({ start: 245, end: 550, speaker: 'Speaker A' });
  });
});
