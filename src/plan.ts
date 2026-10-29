import type { CampaignBundle, ProjectArtifacts } from './types.js';

/** One scheduled publishing action in the 30-day plan. */
export interface PlanItem {
  week: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  weekday: string;
  channel: 'LinkedIn' | 'Email' | 'Website';
  title: string;
  detail: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The Monday at least a week after `from`, leaving time for review and approval. */
export function planStart(from: Date): Date {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 7));
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function short(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * A four-week rhythm: the landing page and guide go live first, two posts a week (Tuesday and
 * Thursday), the carousel in week 2, a video clip most Fridays, and the three emails a week apart.
 */
export function buildPublishingPlan(bundle: CampaignBundle, artifacts: Pick<ProjectArtifacts, 'motionClips' | 'speakerClips' | 'carouselSlides'>, start: Date): PlanItem[] {
  const items: PlanItem[] = [];
  const add = (week: number, weekday: number, channel: PlanItem['channel'], title: string, detail: string) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + (week - 1) * 7 + (weekday - 1));
    items.push({ week, date: iso(date), weekday: WEEKDAYS[date.getUTCDay()] as string, channel, title, detail });
  };

  add(1, 1, 'Website', 'Publish the guide and landing page', `Put the landing-page copy live with the guide "${short(bundle.title, 70)}" as the download.`);
  const emails = bundle.emails;
  if (emails[0]) add(1, 1, 'Email', 'Email 1: deliver the guide', `Subject: ${short(emails[0].subject)}`);
  if (emails[1]) add(2, 1, 'Email', 'Email 2: develop the idea', `Subject: ${short(emails[1].subject)}`);
  if (emails[2]) add(4, 1, 'Email', 'Email 3: invite the next step', `Subject: ${short(emails[2].subject)}`);

  bundle.linkedinPosts.slice(0, 8).forEach((post, index) => {
    add(Math.floor(index / 2) + 1, index % 2 === 0 ? 2 : 4, 'LinkedIn', `Post ${index + 1}`, short(post.hook));
  });
  if (artifacts.carouselSlides?.length) add(2, 3, 'LinkedIn', 'Carousel (document post)', `Upload the carousel PDF: ${short(bundle.carousel?.title ?? bundle.title, 70)}`);

  const clips = [...(artifacts.motionClips ?? []), ...(artifacts.speakerClips ?? [])];
  clips.slice(0, 4).forEach((clip, index) => {
    add(index + 1, 5, 'LinkedIn', `Video clip ${index + 1}`, `${short(clip.title, 70)} (${clip.file.split('/').pop()})`);
  });

  // On the same day the landing page goes live before the email that links to it.
  const channelOrder: Record<PlanItem['channel'], number> = { Website: 0, Email: 1, LinkedIn: 2 };
  return items.sort((a, b) => a.date.localeCompare(b.date) || channelOrder[a.channel] - channelOrder[b.channel]);
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds lines to 75 octets as RFC 5545 requires. */
function fold(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

/** An all-day calendar event per item, importable into Google Calendar, Outlook and Apple Calendar. */
export function publishingPlanIcs(items: PlanItem[], company: string, uidSeed: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Afterword//Publishing plan//EN', 'CALSCALE:GREGORIAN', fold(`X-WR-CALNAME:${icsEscape(`${company} publishing plan`)}`)];
  items.forEach((item, index) => {
    const day = item.date.replace(/-/g, '');
    const next = new Date(`${item.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uidSeed}-${index + 1}@afterwordmonthly.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${iso(next).replace(/-/g, '')}`,
      fold(`SUMMARY:${icsEscape(`${item.channel}: ${item.title}`)}`),
      fold(`DESCRIPTION:${icsEscape(item.detail)}`),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export function publishingPlanMarkdown(items: PlanItem[], company: string): string {
  const rows = items.map((item) => `| Week ${item.week} | ${item.weekday} ${item.date} | ${item.channel} | ${item.title} | ${item.detail.replace(/\|/g, '/')} |`);
  return [`# ${company}: 30-day publishing plan`, '', 'Import publishing-plan.ics into your calendar to get every item as an all-day reminder.', '', '| Week | Date | Channel | What | Details |', '| --- | --- | --- | --- | --- |', ...rows, ''].join('\n');
}
