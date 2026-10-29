import { describe, expect, it } from 'vitest';
import { buildPublishingPlan, planStart, publishingPlanIcs, publishingPlanMarkdown } from '../src/plan.js';
import type { CampaignBundle } from '../src/types.js';

const bundle = {
  campaignAngle: 'A', title: 'The rate the partners approved', subtitle: 'S', executiveSummary: 'E', sections: [], actionChecklist: [],
  linkedinPosts: Array.from({ length: 8 }, (_, index) => ({ hook: `Hook number ${index + 1}, with a comma; and a semicolon`, body: 'B', cta: 'C' })),
  emails: Array.from({ length: 3 }, (_, index) => ({ subject: `Subject ${index + 1}`, preview: 'P', body: 'B', cta: 'C' })),
  landingPage: { eyebrow: 'E', headline: 'H', subheadline: 'S', bullets: ['a', 'b', 'c'], formHeading: 'F', buttonLabel: 'Go' },
  sourceReferences: [],
  carousel: { title: 'Carousel title', slides: [], closing: 'C' },
} as unknown as CampaignBundle;

describe('publishing plan', () => {
  it('starts on a Monday at least a week out, leaving time for review', () => {
    const start = planStart(new Date('2026-10-29T12:00:00Z')); // a Thursday
    expect(start.toISOString().slice(0, 10)).toBe('2026-11-09');
    expect(start.getUTCDay()).toBe(1);
    expect(planStart(new Date('2026-11-02T08:00:00Z')).toISOString().slice(0, 10)).toBe('2026-11-09');
  });

  it('schedules every asset over four weeks: 8 posts on Tue/Thu, carousel in week 2, emails a week apart, clips on Fridays', () => {
    const clip = { file: '/x/motion/figure-clip-01.mp4', poster: '', title: 'A figure', kind: 'stat' as const, durationSeconds: 10 };
    const plan = buildPublishingPlan(bundle, { carouselSlides: ['a.png'], motionClips: [clip, { ...clip, title: 'A quote', kind: 'quote' }] }, new Date('2026-11-09T00:00:00Z'));
    const posts = plan.filter((item) => item.title.startsWith('Post '));
    expect(posts).toHaveLength(8);
    expect(new Set(posts.map((item) => item.weekday))).toEqual(new Set(['Tuesday', 'Thursday']));
    expect(Math.max(...plan.map((item) => item.week))).toBe(4);
    expect(plan.find((item) => item.title.startsWith('Carousel'))).toMatchObject({ week: 2, weekday: 'Wednesday' });
    expect(plan.filter((item) => item.channel === 'Email').map((item) => item.week)).toEqual([1, 2, 4]);
    expect(plan.filter((item) => item.title.startsWith('Video clip')).every((item) => item.weekday === 'Friday')).toBe(true);
    expect(plan[0]).toMatchObject({ date: '2026-11-09', weekday: 'Monday', channel: 'Website' });
    expect(plan[1]).toMatchObject({ date: '2026-11-09', channel: 'Email' });
    expect(plan.map((item) => item.date)).toEqual([...plan.map((item) => item.date)].sort());
  });

  it('writes a valid calendar file and a markdown table', () => {
    const plan = buildPublishingPlan(bundle, {}, new Date('2026-11-09T00:00:00Z'));
    const ics = publishingPlanIcs(plan, 'Northstar, Advisory', 'project-1');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(plan.length);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261109');
    expect(ics).toContain('\\,');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(publishingPlanMarkdown(plan, 'Northstar')).toContain('| Week 1 | Monday 2026-11-09 |');
  });
});
