import type { CampaignBundle, ClientMemory, QualityReport } from './types.js';

export const MAX_TRANSCRIPT_CHARS = 180_000;

/** Phrases that make copy read as generated. Flagged as a warning, not a blocker. */
export const GENERIC_PHRASES = [
  "in today's fast-paced", 'in the ever-evolving', 'game-changer', 'game changer', 'delve', 'navigate the complexities',
  "let's dive in", 'unlock the power', 'unlock the full potential', 'in the realm of', 'a testament to', 'tapestry',
  'elevate your', 'supercharge', 'look no further', 'the secret sauce',
];

export function inspectCampaign(bundle: CampaignBundle, transcript = '', memory?: Pick<ClientMemory, 'bannedPhrases'>): QualityReport {
  const serialized = JSON.stringify(bundle);
  const hooks = bundle.linkedinPosts.map((post) => post.hook.trim().toLowerCase());
  const unverified = transcript.trim() ? findUnverifiedQuotes(bundle, transcript) : [];
  const text = campaignText(bundle);
  const banned = findPhrases(text, memory?.bannedPhrases ?? []);
  const generic = findPhrases(text, GENERIC_PHRASES);
  const quoteCount = bundle.sourceReferences.length + bundle.sections.filter((section) => section.pullQuote).length;
  const checks: QualityReport['checks'] = [
    { name: 'Complete monthly bundle', status: bundle.linkedinPosts.length === 8 && bundle.emails.length === 3 ? 'pass' : 'fail', detail: `${bundle.linkedinPosts.length} social posts and ${bundle.emails.length} emails generated.` },
    { name: 'Editorial depth', status: bundle.sections.length >= 4 ? 'pass' : 'fail', detail: `${bundle.sections.length} substantive guide sections generated.` },
    { name: 'Unique social hooks', status: new Set(hooks).size === hooks.length ? 'pass' : 'warning', detail: `${new Set(hooks).size} unique hooks across ${hooks.length} posts.` },
    { name: 'No unresolved template tokens', status: /\{\{|\}\}/.test(serialized) ? 'fail' : 'pass', detail: 'Generated content contains no unresolved template syntax.' },
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

function campaignText(bundle: CampaignBundle): string {
  return [
    bundle.title, bundle.subtitle, bundle.campaignAngle, bundle.executiveSummary,
    ...bundle.sections.flatMap((section) => [section.title, ...section.body, section.pullQuote ?? '']),
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
  const source = tokenize(stripTranscriptMarkup(transcript));
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

function stripTranscriptMarkup(transcript: string): string {
  // Remove "[00:00] Speaker A:" prefixes so quotes spanning two segments still match.
  return transcript.replace(/^\s*\[[^\]]*\]\s*[^:\n]{0,40}:/gm, ' ');
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
