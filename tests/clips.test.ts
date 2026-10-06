import { describe, expect, it } from 'vitest';
import { planMotionClips } from '../src/motion.js';
import { chunkCaptions, estimateWords, planSpeakerClips } from '../src/speaker-clips.js';
import { parseTranscriptSegments } from '../src/quality.js';
import type { CampaignBundle } from '../src/types.js';

const transcript = [
  '[00:00] Speaker A: Most teams already have more expertise than they publish.',
  '[00:04] Speaker A: The problem is that the knowledge is trapped inside meetings, webinars, and individual conversations.',
  '[00:10] Speaker B: The useful shift is to treat a recording as source evidence rather than finished content.',
  '[00:16] Speaker B: That changes what you do in the first hour after a session.',
  '[00:21] Speaker A: We went back through 40 client webinars from last year.',
  '[00:25] Speaker A: 31 of them were never used again after the live session.',
  '[00:30] Speaker A: A summary tells people what was said.',
  '[00:33] Speaker A: An argument tells them what to do differently on Monday.',
  '[00:38] Speaker B: The buyers we interviewed did not want more content.',
  '[00:42] Speaker B: They wanted one clear way to decide.',
].join('\n');

function bundle(): CampaignBundle {
  return {
    campaignAngle: 'Angle', title: 'Guide', subtitle: 'Sub', executiveSummary: 'Summary',
    sections: [
      { eyebrow: 'A', title: 'Expertise that never leaves the room', body: ['Body'], pullQuote: 'Most teams already have more expertise than they publish.', sourceTimestamp: '00:00' },
      { eyebrow: 'B', title: 'The recording is not the asset', body: ['Body'], layout: 'stat', stat: { value: '31 of 40', label: 'webinars were never used again', context: 'A year of client webinars', sourceTimestamp: '00:25' }, pullQuote: 'treat a recording as source evidence', sourceTimestamp: '00:10' },
      { eyebrow: 'C', title: 'A summary reports. An argument decides.', body: ['Body'], pullQuote: 'An argument tells them what to do differently on Monday.', sourceTimestamp: '00:33' },
      { eyebrow: 'D', title: 'Tests', body: ['Body'], pullQuote: 'Too short.', sourceTimestamp: '00:42' },
    ],
    actionChecklist: ['1', '2', '3', '4'],
    linkedinPosts: Array.from({ length: 8 }, () => ({ hook: 'H', body: 'B', cta: 'C' })),
    emails: Array.from({ length: 3 }, () => ({ subject: 'S', preview: 'P', body: 'B', cta: 'C' })),
    landingPage: { eyebrow: 'E', headline: 'H', subheadline: 'S', bullets: ['a', 'b', 'c'], formHeading: 'F', buttonLabel: 'Get it' },
    sourceReferences: [{ claim: 'Buyers want one way to decide', quote: 'They wanted one clear way to decide.', speaker: 'Speaker B', timestamp: '00:42' }],
  };
}

describe('motion clip planning', () => {
  it('uses only verified material: the guide figure and a complete-sentence pull quote', () => {
    const specs = planMotionClips(bundle());
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ kind: 'stat', value: '31 of 40', payoff: 'The recording is not the asset', timestamp: '00:25' });
    // A complete sentence from a section other than the figure's; never the lower-case fragment.
    expect(specs[1]?.kind).toBe('quote');
    expect(['Most teams already have more expertise than they publish.', 'An argument tells them what to do differently on Monday.']).toContain(specs[1]?.kind === 'quote' ? specs[1].quote : '');
  });

  it('plans no clips when there is no figure and no usable quote', () => {
    const empty = bundle();
    empty.sections = empty.sections.map((section) => ({ ...section, layout: undefined, stat: undefined, pullQuote: undefined }));
    expect(planMotionClips(empty)).toEqual([]);
  });
});

describe('clips from the recording', () => {
  it('cuts non-overlapping 15-55 second windows around verified quotes', () => {
    const windows = planSpeakerClips(bundle(), transcript, 48);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ start: 0, headline: 'Expertise that never leaves the room', timestamp: '00:00' });
    expect(windows[0]!.end - windows[0]!.start).toBeGreaterThanOrEqual(15);
    expect(windows[1]!.start).toBeGreaterThanOrEqual(windows[0]!.end);
    for (const window of windows) expect(window.end - window.start).toBeLessThanOrEqual(55);
  });

  it('caps a window when the transcript has one very long segment', () => {
    const sparse = '[00:00] Speaker A: Most teams already have more expertise than they publish.\n[05:00] Speaker A: Something else entirely.';
    const [window] = planSpeakerClips(bundle(), sparse, 600);
    expect(window!.end - window!.start).toBeLessThanOrEqual(55.5);
  });

  it('builds readable captions without stranded words', () => {
    const words = estimateWords(parseTranscriptSegments(transcript), { start: 0, end: 16.4 });
    const captions = chunkCaptions(words, 16.4);
    expect(captions.length).toBeGreaterThan(2);
    for (const caption of captions) {
      expect(caption.text.length).toBeLessThanOrEqual(74);
      expect(caption.end).toBeGreaterThan(caption.start);
    }
    expect(captions.some((caption) => caption.text.split(/\s+/).length <= 2)).toBe(false);
    expect(captions[0]?.text).toBe('Most teams already have more expertise than they publish.');
  });
});
