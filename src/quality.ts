import { effectiveLayout, type CampaignBundle, type ClientMemory, type QualityReport } from './types.js';

export const MAX_TRANSCRIPT_CHARS = 180_000;

/** Phrases that make copy read as generated. Flagged as a warning, not a blocker. */
export const GENERIC_PHRASES = [
  "in today's fast-paced", 'in the ever-evolving', 'game-changer', 'game changer', 'delve', 'navigate the complexities',
  "let's dive in", 'unlock the power', 'unlock the full potential', 'in the realm of', 'a testament to', 'tapestry',
  'elevate your', 'supercharge', 'look no further', 'the secret sauce',
];

export function inspectCampaign(bundle: CampaignBundle, transcript = '', memory?: Pick<ClientMemory, 'bannedPhrases'>): QualityReport {
  const hooks = bundle.linkedinPosts.map((post) => post.hook.trim().toLowerCase());
  const unverified = transcript.trim() ? findUnverifiedQuotes(bundle, transcript) : [];
  const stats = bundle.sections.filter((section) => effectiveLayout(section) === 'stat' && section.stat).map((section) => section.stat!.value);
  const unverifiedStats = transcript.trim() ? findUnverifiedStats(bundle, transcript) : [];
  const distantStats = transcript.trim() ? findDistantStats(bundle, transcript) : [];
  const layouts = bundle.sections.map((section) => effectiveLayout(section));
  const visualLayouts = layouts.filter((layout) => layout !== 'essay');
  const text = campaignText(bundle);
  const banned = findPhrases(text, memory?.bannedPhrases ?? []);
  const generic = findPhrases(text, GENERIC_PHRASES);
  const quoteCount = bundle.sourceReferences.length + bundle.sections.filter((section) => section.pullQuote).length;
  const checks: QualityReport['checks'] = [
    { name: 'Complete monthly bundle', status: bundle.linkedinPosts.length === 8 && bundle.emails.length === 3 ? 'pass' : 'fail', detail: `${bundle.linkedinPosts.length} social posts and ${bundle.emails.length} emails generated.` },
    { name: 'Editorial depth', status: bundle.sections.length >= 4 ? 'pass' : 'fail', detail: `${bundle.sections.length} substantive guide sections generated.` },
    { name: 'Unique social hooks', status: new Set(hooks).size === hooks.length ? 'pass' : 'warning', detail: `${new Set(hooks).size} unique hooks across ${hooks.length} posts.` },
    // Check the copy itself, not the serialized JSON: nested objects legitimately end in "}}".
    { name: 'No unresolved template tokens', status: allStrings(bundle).some((value) => /\{\{|\}\}/.test(value)) ? 'fail' : 'pass', detail: 'Generated content contains no unresolved template syntax.' },
    { name: 'Source traceability', status: bundle.sourceReferences.length > 0 ? 'pass' : 'warning', detail: bundle.sourceReferences.length ? `${bundle.sourceReferences.length} source references included.` : 'No source references were available; review claims manually.' },
    {
      name: 'Quotes verified against source',
      status: !transcript.trim() ? 'warning' : unverified.length ? 'fail' : 'pass',
      detail: !transcript.trim()
        ? 'No transcript available; quotes could not be verified.'
        : unverified.length
          ? `${unverified.length} of ${quoteCount} quotes not found in the transcript: ${unverified.map((quote) => `“${quote.slice(0, 80)}”`).join('; ')}`
          : `${quoteCount} quotes matched the transcript.`,
    },
    {
      name: 'Figures verified against source',
      status: !stats.length ? 'pass' : !transcript.trim() ? 'warning' : unverifiedStats.length ? 'fail' : distantStats.length ? 'warning' : 'pass',
      detail: !stats.length
        ? 'The guide states no figures.'
        : !transcript.trim()
          ? 'No transcript available; figures could not be verified.'
          : unverifiedStats.length
            ? `Not found in the transcript: ${unverifiedStats.map((value) => `“${value}”`).join(', ')}`
            : distantStats.length
              ? `In the transcript, but not near the cited timestamp; check the timestamp: ${distantStats.map((value) => `“${value}”`).join(', ')}`
              : `${stats.length} figure${stats.length === 1 ? '' : 's'} matched the transcript at the cited moment.`,
    },
    {
      name: 'Visual guide layouts',
      status: visualLayouts.length ? 'pass' : 'warning',
      detail: visualLayouts.length
        ? `${visualLayouts.length} of ${layouts.length} sections use a visual layout (${[...new Set(visualLayouts)].join(', ')}).`
        : 'Every section is a plain essay page; the source may support a framework, figure, or comparison.',
    },
    {
      name: 'LinkedIn carousel',
      status: bundle.carousel ? 'pass' : 'warning',
      detail: bundle.carousel ? `${bundle.carousel.slides.length} content slides plus title and closing slides.` : 'No carousel copy; slides will be derived from the guide sections.',
    },
    {
      name: 'Full source considered',
      status: transcript.length > MAX_TRANSCRIPT_CHARS ? 'warning' : 'pass',
      detail: transcript.length > MAX_TRANSCRIPT_CHARS
        ? `Transcript is ${transcript.length.toLocaleString('en')} characters; only the first ${MAX_TRANSCRIPT_CHARS.toLocaleString('en')} were used.`
        : 'The complete transcript was used.',
    },
    {
      name: 'Client banned phrases',
      status: banned.length ? 'fail' : 'pass',
      detail: banned.length ? `Banned by the client but present: ${banned.map((phrase) => `“${phrase}”`).join(', ')}.` : `${memory?.bannedPhrases.length ?? 0} client rules respected.`,
    },
    {
      name: 'No generic AI phrasing',
      status: generic.length ? 'warning' : 'pass',
      detail: generic.length ? `Generic phrasing found: ${generic.map((phrase) => `“${phrase}”`).join(', ')}.` : 'No stock AI phrasing detected.',
    },
    { name: 'Single conversion goal', status: bundle.landingPage.buttonLabel.length > 2 ? 'pass' : 'warning', detail: `Landing page CTA: “${bundle.landingPage.buttonLabel}”.` },
  ];
  const blockers = checks.filter((check) => check.status === 'fail').map((check) => check.name);
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return { score: Math.max(0, 100 - blockers.length * 25 - warnings * 7), checks, blockers };
}

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings);
  return [];
}

function campaignText(bundle: CampaignBundle): string {
  return [
    bundle.title, bundle.subtitle, bundle.campaignAngle, bundle.executiveSummary,
    ...bundle.sections.flatMap((section) => [
      section.title, ...section.body, section.pullQuote ?? '',
      section.framework?.name ?? '', ...(section.framework?.items.flatMap((item) => [item.label, item.detail]) ?? []),
      section.stat?.label ?? '', section.stat?.context ?? '',
      section.comparison?.leftLabel ?? '', section.comparison?.rightLabel ?? '', ...(section.comparison?.rows.flatMap((row) => [row.left, row.right]) ?? []),
    ]),
    ...(bundle.carousel ? [bundle.carousel.title, bundle.carousel.closing, ...bundle.carousel.slides.flatMap((slide) => [slide.heading, slide.body])] : []),
    ...bundle.actionChecklist,
    ...bundle.linkedinPosts.flatMap((post) => [post.hook, post.body, post.cta]),
    ...bundle.emails.flatMap((email) => [email.subject, email.preview, email.body, email.cta]),
    ...Object.values(bundle.landingPage).flat(),
  ].join('\n').toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

function findPhrases(text: string, phrases: string[]): string[] {
  return phrases.filter((phrase) => {
    const needle = phrase.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
  });
}

/** Returns every quote in the bundle that cannot be located in the transcript. */
export function findUnverifiedQuotes(bundle: CampaignBundle, transcript: string): string[] {
  const source = tokenize(transcriptText(transcript));
  const sourceText = ` ${source.join(' ')} `;
  const sourceTrigrams = new Set(ngrams(source, 3));
  const quotes = [
    ...bundle.sourceReferences.map((reference) => reference.quote),
    ...bundle.sections.map((section) => section.pullQuote).filter((quote): quote is string => Boolean(quote)),
  ];
  return [...new Set(quotes)].filter((quote) => !quoteAppearsInSource(quote, sourceText, sourceTrigrams));
}

function quoteAppearsInSource(quote: string, sourceText: string, sourceTrigrams: Set<string>): boolean {
  const words = tokenize(quote);
  if (!words.length) return true;
  if (sourceText.includes(` ${words.join(' ')} `)) return true;
  if (words.length < 5) return false;
  // Tolerate removed filler words, ellipses, and light punctuation edits in longer quotes.
  const trigrams = ngrams(words, 3);
  const matched = trigrams.filter((trigram) => sourceTrigrams.has(trigram)).length;
  return matched / trigrams.length >= 0.8;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function ngrams(words: string[], size: number): string[] {
  if (words.length < size) return [words.join(' ')];
  return Array.from({ length: words.length - size + 1 }, (_, index) => words.slice(index, index + size).join(' '));
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberInWords(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 100) return undefined;
  if (value === 100) return 'hundred';
  if (value < 20) return NUMBER_WORDS[value];
  const tens = TENS[Math.floor(value / 10)] ?? '';
  return value % 10 ? `${tens} ${NUMBER_WORDS[value % 10]}` : tens;
}

/** Returns every guide figure whose numbers cannot be found anywhere in the transcript. */
export function findUnverifiedStats(bundle: CampaignBundle, transcript: string): string[] {
  const source = normalizeForNumbers(transcriptText(transcript));
  return guideStats(bundle).filter((stat) => !statAppearsIn(stat.value, source)).map((stat) => stat.value);
}

/** Figures that are in the transcript, but not within 90 seconds of the timestamp the guide cites. */
export function findDistantStats(bundle: CampaignBundle, transcript: string): string[] {
  const segments = parseTranscriptSegments(transcript);
  if (!segments.length) return [];
  const source = normalizeForNumbers(transcriptText(transcript));
  return guideStats(bundle)
    .filter((stat) => statAppearsIn(stat.value, source))
    .filter((stat) => {
      const at = parseTimestamp(stat.sourceTimestamp);
      if (at === undefined) return true;
      const window = normalizeForNumbers(segments.filter((segment) => Math.abs(segment.start - at) <= 90).map((segment) => segment.text).join(' '));
      return !statAppearsIn(stat.value, window);
    })
    .map((stat) => stat.value);
}

function guideStats(bundle: CampaignBundle) {
  return bundle.sections.filter((section) => effectiveLayout(section) === 'stat' && section.stat).map((section) => section.stat as NonNullable<typeof section.stat>);
}

function statAppearsIn(value: string, source: string): boolean {
  const numbers = value.replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g);
  if (!numbers?.length) {
    // A figure in words ("a third", "half"): the phrase itself must appear.
    const words = tokenize(value).join(' ');
    return Boolean(words) && ` ${source} `.includes(` ${words} `);
  }
  return numbers.every((number) => {
    const digits = new RegExp(`(^|[^\\d.])${number.replace('.', '\\.')}(?![\\d]|\\.\\d)`);
    if (digits.test(source)) return true;
    const words = numberInWords(Number(number));
    return Boolean(words) && new RegExp(`(^|\\s)${words}(\\s|$)`).test(source);
  });
}

function normalizeForNumbers(value: string): string {
  return value.toLowerCase().replace(/(\d),(\d{3})/g, '$1$2').replace(/[-‐-–]/g, ' ').replace(/\s+/g, ' ');
}

export interface TranscriptSegment { start: number; end: number; speaker: string; text: string }

/**
 * Parses "[mm:ss] Speaker: text" (or [h:mm:ss]) lines. Lines without a timestamp continue the
 * previous segment; a colon inside ordinary text is not mistaken for a speaker label.
 * end is the next segment's start.
 */
export function parseTranscriptSegments(transcript: string): TranscriptSegment[] {
  const segments: Array<Omit<TranscriptSegment, 'end'>> = [];
  let timestamped = false;
  for (const line of transcript.split('\n')) {
    const match = line.match(/^\s*\[(\d{1,3}(?::\d{2}){1,2})\]\s*(.*)$/);
    if (match) {
      timestamped = true;
      const rest = match[2] ?? '';
      const label = rest.match(/^([^:]{1,40}):\s*(.*)$/);
      const isSpeaker = Boolean(label && /^\p{Lu}/u.test(label[1] ?? '') && !/\d/.test(label[1] ?? '') && (label[1] ?? '').trim().split(/\s+/).length <= 4);
      segments.push({ start: parseTimestamp(match[1]) ?? 0, speaker: isSpeaker ? (label?.[1] ?? '').trim() : '', text: (isSpeaker ? label?.[2] ?? '' : rest).trim() });
    } else if (line.trim()) {
      const last = segments[segments.length - 1];
      if (last) last.text = `${last.text} ${line.trim()}`.trim();
      else segments.push({ start: 0, speaker: '', text: line.trim() });
    }
  }
  if (!timestamped) return [];
  return segments.map((segment, index) => ({ ...segment, end: segments[index + 1]?.start ?? segment.start + Math.max(4, segment.text.split(/\s+/).length / 2.6) }));
}

/** The spoken words only, without timestamps and speaker labels. */
export function transcriptText(transcript: string): string {
  const segments = parseTranscriptSegments(transcript);
  return segments.length ? segments.map((segment) => segment.text).join('\n') : transcript;
}

/** "18:40", "[18:40]", "1:02:03", "18:40-21:15" -> seconds of the first timestamp. */
export function parseTimestamp(value: string | undefined): number | undefined {
  const match = value?.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
  if (!match) return undefined;
  const [a, b, c] = [Number(match[1]), Number(match[2]), match[3] === undefined ? undefined : Number(match[3])];
  return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c;
}
