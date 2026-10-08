import { createReadStream } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { config } from './config.js';
import { prepareAudioForTranscription } from './media.js';
import { MAX_TRANSCRIPT_CHARS } from './quality.js';
import {
  SECTION_LAYOUTS,
  campaignBundleSchema,
  prospectPreviewSchema,
  prospectQualificationSchema,
  type BrandProfile,
  type CampaignBundle,
  type Client,
  type ClientMemory,
  type Intake,
  type ProspectInput,
  type ProspectPreview,
  type ProspectQualification,
} from './types.js';

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : undefined;

const textItem = (fields: string[]) => ({ type: 'object', additionalProperties: false, required: fields, properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])) });
const nullable = <T extends object>(schema: T) => ({ anyOf: [schema, { type: 'null' }] });

const frameworkJsonSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'kind', 'items'],
  properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['sequence', 'pillars'] }, items: { type: 'array', minItems: 2, maxItems: 6, items: textItem(['label', 'detail']) } },
};
const statJsonSchema = textItem(['value', 'label', 'context', 'sourceTimestamp']);
const comparisonJsonSchema = {
  type: 'object', additionalProperties: false, required: ['leftLabel', 'rightLabel', 'rows'],
  properties: { leftLabel: { type: 'string' }, rightLabel: { type: 'string' }, rows: { type: 'array', minItems: 2, maxItems: 6, items: textItem(['left', 'right']) } },
};
const carouselJsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'slides', 'closing'],
  properties: { title: { type: 'string' }, slides: { type: 'array', minItems: 3, maxItems: 8, items: textItem(['heading', 'body']) }, closing: { type: 'string' } },
};

const bundleJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['campaignAngle', 'title', 'subtitle', 'executiveSummary', 'sections', 'actionChecklist', 'linkedinPosts', 'emails', 'landingPage', 'sourceReferences', 'carousel'],
  properties: {
    campaignAngle: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' }, executiveSummary: { type: 'string' },
    sections: { type: 'array', minItems: 4, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['eyebrow', 'title', 'body', 'pullQuote', 'sourceTimestamp', 'layout', 'framework', 'stat', 'comparison'], properties: {
      eyebrow: { type: 'string' }, title: { type: 'string' }, body: { type: 'array', items: { type: 'string' } },
      pullQuote: { type: ['string', 'null'] }, sourceTimestamp: { type: ['string', 'null'] },
      layout: { type: 'string', enum: [...SECTION_LAYOUTS] },
      framework: nullable(frameworkJsonSchema), stat: nullable(statJsonSchema), comparison: nullable(comparisonJsonSchema),
    } } },
    actionChecklist: { type: 'array', minItems: 4, maxItems: 8, items: { type: 'string' } },
    linkedinPosts: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['hook', 'body', 'cta'], properties: { hook: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } } } },
    emails: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['subject', 'preview', 'body', 'cta'], properties: { subject: { type: 'string' }, preview: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } } } },
    landingPage: { type: 'object', additionalProperties: false, required: ['eyebrow', 'headline', 'subheadline', 'bullets', 'formHeading', 'buttonLabel'], properties: {
      eyebrow: { type: 'string' }, headline: { type: 'string' }, subheadline: { type: 'string' }, bullets: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } }, formHeading: { type: 'string' }, buttonLabel: { type: 'string' },
    } },
    sourceReferences: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['claim', 'quote', 'speaker', 'timestamp'], properties: { claim: { type: 'string' }, quote: { type: 'string' }, speaker: { type: 'string' }, timestamp: { type: 'string' } } } },
    carousel: carouselJsonSchema,
  },
} as const;

const quoteJsonSchema = { type: 'object', additionalProperties: false, required: ['quote', 'speaker', 'timestamp'], properties: { quote: { type: 'string' }, speaker: { type: 'string' }, timestamp: { type: 'string' } } } as const;

const ideasJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['thesisCandidates', 'ideas', 'speakerTerms'],
  properties: {
    thesisCandidates: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
    ideas: { type: 'array', minItems: 5, maxItems: 14, items: { type: 'object', additionalProperties: false, required: ['number', 'idea', 'detail', 'quotes'], properties: {
      number: { type: 'integer' }, idea: { type: 'string' }, detail: { type: 'string' }, quotes: { type: 'array', maxItems: 4, items: quoteJsonSchema },
    } } },
    speakerTerms: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
} as const;

const planJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['thesis', 'campaignAngle', 'title', 'subtitle', 'sections', 'postAngles', 'emailPlan'],
  properties: {
    thesis: { type: 'string' }, campaignAngle: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' },
    sections: { type: 'array', minItems: 4, maxItems: 7, items: { type: 'object', additionalProperties: false, required: ['eyebrow', 'title', 'point', 'ideaNumbers', 'layout'], properties: {
      eyebrow: { type: 'string' }, title: { type: 'string' }, point: { type: 'string' }, ideaNumbers: { type: 'array', items: { type: 'integer' } },
      layout: { type: 'string', enum: [...SECTION_LAYOUTS] },
    } } },
    postAngles: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['angle', 'ideaNumber'], properties: { angle: { type: 'string' }, ideaNumber: { type: 'integer' } } } },
    emailPlan: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['job', 'focus'], properties: { job: { type: 'string', enum: ['deliver', 'develop', 'invite'] }, focus: { type: 'string' } } } },
  },
} as const;

const guideJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['executiveSummary', 'sections', 'actionChecklist', 'sourceReferences'],
  properties: {
    executiveSummary: bundleJsonSchema.properties.executiveSummary,
    sections: bundleJsonSchema.properties.sections,
    actionChecklist: bundleJsonSchema.properties.actionChecklist,
    sourceReferences: bundleJsonSchema.properties.sourceReferences,
  },
} as const;

const derivativesJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['linkedinPosts', 'emails', 'landingPage', 'carousel'],
  properties: {
    linkedinPosts: bundleJsonSchema.properties.linkedinPosts,
    emails: bundleJsonSchema.properties.emails,
    landingPage: bundleJsonSchema.properties.landingPage,
    carousel: carouselJsonSchema,
  },
} as const;

const lessonsJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['terminology', 'bannedPhrases', 'styleNotes'],
  properties: {
    terminology: { type: 'array', maxItems: 10, items: { type: 'string' } },
    bannedPhrases: { type: 'array', maxItems: 10, items: { type: 'string' } },
    styleNotes: { type: 'array', maxItems: 10, items: { type: 'string' } },
  },
} as const;

const prospectJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['qualification', 'preview'],
  properties: {
    qualification: {
      type: 'object', additionalProperties: false,
      required: ['score', 'tier', 'fitReasons', 'risks', 'likelyAudience', 'likelyOffer', 'sourceSignal', 'personalizationAngle'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        tier: { type: 'string', enum: ['A', 'B', 'C', 'reject'] },
        fitReasons: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
        risks: { type: 'array', maxItems: 4, items: { type: 'string' } },
        likelyAudience: { type: 'string' }, likelyOffer: { type: 'string' },
        sourceSignal: { type: 'string' }, personalizationAngle: { type: 'string' },
      },
    },
    preview: {
      type: 'object', additionalProperties: false,
      required: ['campaignAngle', 'guideTitle', 'guideSubtitle', 'whyNow', 'sourceMoment', 'articleAngles', 'linkedinHooks', 'outreachSubject', 'outreachBody'],
      properties: {
        campaignAngle: { type: 'string' }, guideTitle: { type: 'string' }, guideSubtitle: { type: 'string' },
        whyNow: { type: 'string' }, sourceMoment: { type: 'string' },
        articleAngles: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
        linkedinHooks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
        outreachSubject: { type: 'string' }, outreachBody: { type: 'string' },
      },
    },
  },
} as const;

export function isLiveAi(): boolean { return Boolean(client); }

export async function transcribeFile(filePath: string): Promise<string> {
  if (!client) return demoTranscript;
  // Large uploads (any video, long audio) are reduced to a small speech MP3 first: the API caps files at 25 MB.
  const speech = await prepareAudioForTranscription(filePath, path.join(config.uploadDir, '.work'));
  const response = await client.audio.transcriptions.create({
    file: createReadStream(speech),
    model: config.transcriptionModel,
    response_format: 'diarized_json',
    chunking_strategy: 'auto',
  });
  if ('segments' in response && Array.isArray(response.segments)) {
    return response.segments.map((segment) => {
      const row = segment as { speaker?: string; start?: number; text?: string };
      return `[${formatTime(row.start ?? 0)}] ${row.speaker ?? 'Speaker'}: ${row.text ?? ''}`;
    }).join('\n');
  }
  return 'text' in response ? String(response.text) : JSON.stringify(response);
}

export interface TimedWord { word: string; start: number; end: number }

/** Word-level timings for captions; undefined when no transcription model is configured. */
export async function transcribeWords(filePath: string): Promise<TimedWord[] | undefined> {
  if (!client) return undefined;
  const response = await client.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: config.captionModel,
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  });
  const words = (response as { words?: Array<{ word?: string; start?: number; end?: number }> }).words ?? [];
  return words
    .filter((word) => word.word?.trim())
    .map((word) => ({ word: (word.word as string).trim(), start: Number(word.start ?? 0), end: Number(word.end ?? word.start ?? 0) }));
}

export interface CampaignContext {
  intake: Intake;
  brand: BrandProfile;
  transcript: string;
  revisionNote?: string;
  client?: Client;
  /** Called before each writing stage so the operator can follow progress. */
  onStage?: (message: string) => Promise<unknown>;
}

const SOURCE_RULES = `Never invent statistics, customers, quotes, results, or opinions. Quotes must be copied verbatim from the transcript, with the transcript timestamp; they are verified automatically and the delivery is blocked if a quote cannot be found. Figures must be exactly as the speaker said them; never calculate, round, or combine numbers.`;

const LAYOUT_RULES = `Each section is one printed A4 page with a layout:
- essay: two to four paragraphs, at most 280 words of body copy.
- framework: when the speaker describes a sequence of steps (kind "sequence") or a set of named parts (kind "pillars"). Three to five items; label at most five words, detail at most 24 words. One or two paragraphs of body copy, at most 160 words.
- stat: only when the speaker states a specific figure. value is the figure exactly as said (for example "31 of 40" or "40%"), label at most twelve words saying what was counted, context at most eighteen words, sourceTimestamp where it was said. Figures are verified against the transcript near that timestamp and the delivery is blocked if one cannot be found. One or two paragraphs, at most 170 words.
- comparison: when the argument contrasts two approaches. leftLabel names the common approach and rightLabel the better one; three to five rows, each cell at most fourteen words. One or two paragraphs, at most 160 words.
Use the planned layout unless the source does not support it. When the source allows, use at least two layouts besides essay, and never place two identical non-essay layouts next to each other. Set every unused feature field to null.`;
const STYLE_RULES = `Use clear international English. Write like a senior practitioner, not a marketer. No AI clichés (for example "in today's fast-paced world", "game-changer", "unlock", "delve", "navigate the complexities", "let's dive in", "it's not just X, it's Y"). No inflated claims, no exclamation marks, no emoji, no hashtags inside sentences.`;

/**
 * Staged editorial pipeline: extract ideas and verbatim quotes, choose one thesis and plan,
 * write the guide, derive posts, emails and landing copy from the guide, then run an editor pass.
 */
export async function generateCampaign(context: CampaignContext): Promise<CampaignBundle> {
  if (!client) return createDemoBundle(context.intake, context.transcript, context.revisionNote ?? '');
  const stage = async (message: string) => { await context.onStage?.(message); };
  const brief = clientBrief(context);

  await stage('Extracting ideas and verbatim quotes from the source');
  const ideas = await structured<unknown>('adforge_source_ideas', ideasJsonSchema,
    `You are the research editor inside Afterword. Read the full transcript and extract the ideas worth publishing, in the speaker's own framing. ${SOURCE_RULES} Prefer specific, contrarian, or experience-based points over generic advice. Record the speaker's own recurring terms.`,
    `${brief}\n\nSOURCE TRANSCRIPT\n${context.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`);

  await stage('Choosing one thesis and planning the campaign');
  const plan = await structured<{ campaignAngle: string; title: string; subtitle: string }>('adforge_campaign_plan', planJsonSchema,
    `You are the senior B2B editor inside Afterword. Choose ONE central thesis that is useful to the audience and naturally supports the client's offer without becoming a brochure. Plan a guide of 4 to 7 sections that builds one argument, eight LinkedIn angles that each carry a different idea, and three emails with the jobs deliver, develop, invite. Give each section a layout (essay, framework, stat, comparison) that fits what the source actually contains: framework only when the speaker gives steps or named parts, stat only when the speaker states a figure, comparison only when the argument contrasts two approaches. Do not repeat angles or hooks from past campaigns. Honour every client rule and correction.`,
    `${brief}\n\nEXTRACTED IDEAS\n${JSON.stringify(ideas)}`);

  await stage('Writing the premium guide');
  const guide = await structured<Record<string, unknown>>('adforge_campaign_guide', guideJsonSchema,
    `You are the senior B2B editor inside Afterword writing the guide on behalf of the client company. Follow the plan exactly: one section per planned section, in order. ${SOURCE_RULES}\n${LAYOUT_RULES}\nPull quotes must come from the extracted quotes. The guide must feel edited, not summarized: argue, give examples from the source, and make each section end on a usable point. ${STYLE_RULES}`,
    `${brief}\n\nPLAN\n${JSON.stringify(plan)}\n\nEXTRACTED IDEAS AND QUOTES\n${JSON.stringify(ideas)}`);

  await stage('Writing LinkedIn posts, emails, and landing copy');
  const expert = context.client?.expertName || context.intake.expertName || 'the expert speaker';
  const derived = await structured<Record<string, unknown>>('adforge_campaign_derivatives', derivativesJsonSchema,
    `You write distribution copy for Afterword. LinkedIn posts and emails are written in the first person as ${expert}, matching the voice reference closely (sentence length, directness, vocabulary, formatting). Each LinkedIn post carries its planned angle, stands alone without the guide, is 120 to 220 words, opens with a specific first line rather than a generic claim, and uses short paragraphs. Emails have one job each (deliver the guide, develop its sharpest idea, invite the next step) and are under 180 words. Landing copy is labelled blocks for a guide download page. The carousel is a LinkedIn document post that teaches the guide's argument on its own: title at most nine words; five to seven slides in the order of the guide, one idea each, heading at most eight words and body at most thirty words; closing at most fourteen words, inviting the reader to get the full guide. No quotation marks and no figures in the carousel unless they appear in the guide. ${SOURCE_RULES} ${STYLE_RULES}`,
    `${brief}\n\nPLAN\n${JSON.stringify(plan)}\n\nFINISHED GUIDE\n${JSON.stringify(guide)}`);

  const draft = normalizeBundle({ campaignAngle: plan.campaignAngle, title: plan.title, subtitle: plan.subtitle, ...guide, ...derived });

  await stage('Editor pass: voice, repetition, and client rules');
  return editBundle(context, draft, [
    'Tighten every asset. Remove repetition across the eight posts, clichés, filler, and anything that sounds generated.',
    'Enforce every terminology rule and never use a banned phrase.',
    'Keep verbatim quotes and figures exactly as written. Keep the structure, the section layouts and feature blocks, and the number of items; tighten wording within the same limits.',
  ]);
}

/** Targeted rewrite after a failed quality gate; far cheaper than regenerating the campaign. */
export async function repairCampaign(context: CampaignContext, bundle: CampaignBundle, failures: string[]): Promise<CampaignBundle> {
  if (!client) return bundle;
  await context.onStage?.('Repairing the draft after a failed quality gate');
  return editBundle(context, bundle, [
    'The draft failed automated checks. Fix exactly these problems and change nothing else:',
    ...failures.map((failure) => `- ${failure}`),
    'For a quote that could not be found, replace it with a verbatim sentence from the transcript or remove it.',
    'For a figure that could not be found, use the figure exactly as said in the transcript, or change that section to the essay layout and set stat to null.',
  ], true);
}

/** Distils a client's revision note into durable rules for future months. */
export async function distilRevision(note: string, memory: ClientMemory): Promise<Pick<ClientMemory, 'terminology' | 'bannedPhrases' | 'styleNotes'>> {
  if (!client) return { terminology: [], bannedPhrases: [], styleNotes: [] };
  return structured('adforge_revision_lessons', lessonsJsonSchema,
    `You maintain a client's editorial memory. From one revision note, extract only durable preferences that should apply to future months: terminology rules ("Say X, not Y"), phrases to never use, and general style notes. Ignore one-off content edits and factual fixes about this month's material. Do not repeat rules already in memory. Return empty arrays when nothing is durable.`,
    `CURRENT MEMORY\n${JSON.stringify({ terminology: memory.terminology, bannedPhrases: memory.bannedPhrases, styleNotes: memory.styleNotes })}\n\nREVISION NOTE\n${note}`);
}

async function editBundle(context: CampaignContext, bundle: CampaignBundle, tasks: string[], includeTranscript = false): Promise<CampaignBundle> {
  const edited = await structured<unknown>('adforge_campaign_bundle', bundleJsonSchema,
    `You are the final editor inside Afterword. Return the complete campaign in the same structure. ${SOURCE_RULES}\n${LAYOUT_RULES}\n${STYLE_RULES}`,
    `${clientBrief(context)}\n\nEDITOR TASKS\n${tasks.join('\n')}\n\nCAMPAIGN\n${JSON.stringify(bundle)}${includeTranscript ? `\n\nSOURCE TRANSCRIPT\n${context.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}` : ''}`);
  return normalizeBundle(edited);
}

function clientBrief(context: CampaignContext): string {
  const { intake, brand, revisionNote } = context;
  const memory = context.client?.memory;
  const campaigns = context.client?.campaigns.slice(-6) ?? [];
  const corrections = context.client?.corrections.slice(-10) ?? [];
  const voice = memory?.voiceExamples.length ? memory.voiceExamples : [];
  const list = (items: string[] | undefined, empty: string) => items?.length ? items.map((item) => `- ${item}`).join('\n') : empty;
  return [
    `CLIENT\nCompany: ${intake.companyName}\nExpert: ${context.client?.expertName || intake.expertName || 'The main speaker in the source'}\nAudience: ${intake.audience}\nOffer: ${intake.offer}\nCTA: ${intake.callToAction}\nTone notes: ${intake.toneNotes || 'Clear, expert, direct'}`,
    `VOICE REFERENCE (the expert's own writing; match it)\n${voice.length ? voice.map((example, index) => `[Example ${index + 1}]\n${example}`).join('\n\n') : 'No examples supplied. Write plainly in the first person as a senior practitioner.'}`,
    `TERMINOLOGY RULES\n${list(memory?.terminology, 'None yet.')}`,
    `BANNED PHRASES (never use)\n${list(memory?.bannedPhrases, 'None yet.')}`,
    `STYLE NOTES FROM EARLIER REVIEWS\n${list(memory?.styleNotes, 'None yet.')}`,
    `PAST CAMPAIGNS (do not repeat these angles or hooks)\n${campaigns.length ? campaigns.map((item) => `- ${item.approvedAt.slice(0, 7)}: ${item.campaignAngle} | hooks: ${item.hooks.slice(0, 8).join(' / ')}`).join('\n') : 'None; this is the first month.'}`,
    `PAST CLIENT CORRECTIONS\n${corrections.length ? corrections.map((item) => `- ${item.note.slice(0, 600)}`).join('\n') : 'None.'}`,
    `COMPANY WEBSITE COPY (terminology and offer reference only; not the voice)\n${brand.description}\n${brand.voiceSample.slice(0, 2_000)}`,
    `REVISION NOTE FOR THIS EDITION\n${revisionNote || 'First edition'}`,
  ].join('\n\n');
}

async function structured<T>(name: string, schema: object, instructions: string, input: string): Promise<T> {
  if (!client) throw new Error('Structured generation requires OPENAI_API_KEY');
  const response = await client.responses.create({
    model: config.contentModel,
    store: false,
    instructions,
    input,
    text: { format: { type: 'json_schema', name, strict: true, schema: schema as Record<string, unknown> } },
  });
  if (!response.output_text) throw new Error(`The content model returned no output (${name})`);
  return JSON.parse(response.output_text) as T;
}

function normalizeBundle(value: unknown): CampaignBundle {
  const normalized = campaignBundleSchema.parse(value);
  return {
    ...normalized,
    sections: normalized.sections.map((section) => ({
      ...section,
      pullQuote: section.pullQuote ?? undefined,
      sourceTimestamp: section.sourceTimestamp ?? undefined,
    })),
  };
}

export async function generateProspectPreview(
  input: ProspectInput,
  brand: BrandProfile,
): Promise<{ qualification: ProspectQualification; preview: ProspectPreview }> {
  if (!client) return createDemoProspectPreview(input, brand);
  const response = await client.responses.create({
    model: config.contentModel,
    store: false,
    instructions: `You are the research editor for Afterword, a productized B2B content service. Qualify one company and create a highly specific campaign preview from supplied evidence only. The ideal customer is an English-speaking boutique consultancy, training firm, or expert-led professional-services company with a high-value offer and useful long-form source material. Never invent revenue, team size, customers, outcomes, quotes, or facts. Do not flatter. Reject weak fits. The outreach email must be plain text, under 120 words, mention the exact source title naturally, explain one observed content opportunity, link conceptually to the preview, state the $1,500/month price, and end with a low-friction asynchronous question. Do not request a meeting.`,
    input: `COMPANY\n${input.companyName}\nWebsite: ${input.website}\nContact: ${input.contactName || 'Unknown'}${input.role ? `, ${input.role}` : ''}\nCountry: ${input.country || 'Unknown'}\nOffer hint: ${input.offerHint || 'Infer cautiously from supplied website signals'}\nNotes: ${input.notes || 'None'}\n\nPUBLIC SOURCE\nTitle: ${input.sourceTitle}\nURL: ${input.sourceUrl}\nOperator-supplied summary/excerpt:\n${input.sourceSummary}\n\nWEBSITE SIGNALS\nTitle: ${brand.title}\nDescription: ${brand.description}\nVisible copy excerpt: ${brand.voiceSample.slice(0, 8_000)}`,
    text: { format: { type: 'json_schema', name: 'adforge_prospect_preview', strict: true, schema: prospectJsonSchema } },
  });
  if (!response.output_text) throw new Error('The prospect model returned no output');
  const parsed = JSON.parse(response.output_text) as { qualification?: unknown; preview?: unknown };
  return {
    qualification: prospectQualificationSchema.parse(parsed.qualification),
    preview: prospectPreviewSchema.parse(parsed.preview),
  };
}

function demoPullQuote(transcript: string): string | undefined {
  const line = transcript.split('\n').map((row) => row.replace(/^\s*\[[^\]]*\]\s*[^:]{0,40}:\s*/, '').trim()).find((row) => row.length > 20);
  return line?.split(/(?<=[.!?])\s+/)[0];
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function createDemoBundle(intake: Intake, transcript: string, revisionNote: string): CampaignBundle {
  // The demo transcript backs every quote and figure below, so demo campaigns pass the same source checks.
  const usesDemoSource = transcript.trim() === demoTranscript.trim() || !transcript.trim();
  // With a real transcript but no AI key, only the opening section borrows a verbatim line from it.
  const quote = (text: string, opening = false) => (usesDemoSource ? text : opening ? demoPullQuote(transcript) : undefined);
  const company = intake.companyName;
  const sections: CampaignBundle['sections'] = [
    {
      eyebrow: 'The problem', title: 'Expertise that never leaves the room',
      body: [
        'Most expert-led firms are not short of ideas. Every month their senior people explain, debate, and refine a point of view in client meetings, webinars, and workshops. Very little of it reaches the buyers who were not in the room.',
        'The reason is rarely effort. Turning an hour of talk into something a buyer can use takes a different skill from giving the talk, and nobody owns that job. So the recording goes into a folder and the insight goes nowhere.',
        `This guide treats that recording as evidence. It shows how ${company} turns one argument into a decision the reader can make, and why that is worth more than another round of content.`,
      ],
      pullQuote: quote('Most teams already have more expertise than they publish.', true), sourceTimestamp: usesDemoSource ? '00:00' : undefined, layout: 'essay',
    },
    {
      eyebrow: 'The evidence', title: 'The recording is not the asset',
      body: [
        'A webinar has an audience of forty for one hour. After that it is a file. The work that turns it into an asset, choosing the argument and making it usable, almost never happens.',
        'The useful shift is to stop treating a recording as finished content and start treating it as source material: something to quote, test, and build on.',
      ],
      layout: usesDemoSource ? 'stat' : 'essay',
      stat: usesDemoSource ? { value: '31 of 40', label: 'client webinars were never used again after the live session', context: 'A review of one year of client webinars', sourceTimestamp: '04:05' } : undefined,
      pullQuote: quote('treat a recording as source evidence rather than finished content'), sourceTimestamp: usesDemoSource ? '02:18' : undefined,
    },
    {
      eyebrow: 'The method', title: 'Three moves that make an idea repeatable',
      body: [
        'The teams that turn expertise into pipeline do not publish more. They make one idea easy to repeat, in the same words, by everyone who talks to a buyer.',
        'Each move is small on its own. Together they turn an opinion into a decision the reader can make without you in the room.',
      ],
      layout: 'framework',
      framework: { name: 'The decision sequence', kind: 'sequence', items: [
        { label: 'Name the decision', detail: 'State the one choice the reader should make differently after reading, in a single sentence.' },
        { label: 'Show the evidence', detail: 'Support it with what the expert has seen first-hand, quoted and traceable to the moment it was said.' },
        { label: 'Make the next step small', detail: 'End with an action the reader can take this week without asking anyone for budget.' },
      ] },
      sourceTimestamp: usesDemoSource ? '09:10' : undefined,
    },
    {
      eyebrow: 'The difference', title: 'A summary reports. An argument decides.',
      body: [
        'Most repurposed content is a summary: it reports what was said, in the order it was said. Buyers skim it and move on, because it asks nothing of them.',
        'An argument commits to one point and tells the reader what to do about it. It is shorter, sharper, and far easier to share inside a buying committee.',
      ],
      layout: 'comparison',
      comparison: { leftLabel: 'A summary', rightLabel: 'An argument', rows: [
        { left: 'Reports what was said', right: 'Says what to do differently on Monday' },
        { left: 'Covers every topic in the recording', right: 'Commits to one decision and defends it' },
        { left: 'Ends when the recording ends', right: 'Ends with a next step the reader can take' },
        { left: 'Interchangeable with any firm', right: 'Recognisably yours, in your words' },
      ] },
      pullQuote: quote('An argument tells them what to do differently on Monday.'), sourceTimestamp: usesDemoSource ? '12:30' : undefined,
    },
    {
      eyebrow: 'Before you publish', title: 'Three tests buyers apply without telling you',
      body: [
        'The buyers we interviewed did not ask for more content. They wanted to know what to decide and why to trust the person telling them.',
        `${company} applies these three tests to every piece before it leaves the building. Use them on your next recording before you publish anything.`,
      ],
      layout: 'framework',
      framework: { name: 'The publishing test', kind: 'pillars', items: [
        { label: 'One sentence', detail: 'Can your account team repeat the idea in one sentence without notes?' },
        { label: 'One piece of evidence', detail: 'Is there a moment from real work that proves it, quoted as it was said?' },
        { label: 'One next step', detail: 'Does the reader know exactly what to do this week?' },
      ] },
      pullQuote: quote('They wanted one clear way to decide.'), sourceTimestamp: usesDemoSource ? '15:02' : undefined,
    },
  ];
  const hooks = [
    'Most expert firms are not short of ideas.', '31 of 40 webinars were never used again.', 'A recording is evidence, not content.',
    'Three moves make an idea repeatable.', 'A summary reports. An argument decides.', 'Buyers do not want more content.',
    'If your team cannot repeat it, it does not exist.', 'The final step is the one nobody owns.',
  ];
  return {
    campaignAngle: revisionNote ? `Revised around: ${revisionNote}` : 'Turn one expert insight into a decision buyers can make without you in the room',
    title: 'The Repeatable Decision',
    subtitle: `How ${intake.audience.charAt(0).toLowerCase()}${intake.audience.slice(1)} turn one expert insight into a decision their buyers can act on`,
    executiveSummary: `Expert-led firms produce more insight than they ever publish. This guide shows why the recording is not the asset, the three moves that make an idea repeatable, and the tests buyers apply before they trust it. It ends with a checklist you can use on your next recording.`,
    sections,
    actionChecklist: ['Name the one decision your next recording should change', 'Find the moment in the recording that proves it', 'Write the idea as one sentence your team can repeat', 'Cut every section that does not support that decision', 'End with one next step a reader can take this week'],
    linkedinPosts: hooks.map((hook, index) => ({
      hook,
      body: `${sections[index % sections.length]?.body[0] ?? ''}\n\nThe point is not to publish more. It is to make one valuable idea easier to understand and use.`,
      cta: index > 5 ? intake.callToAction : 'What does this look like inside your team?',
    })),
    emails: [0, 1, 2].map((index) => ({ subject: ['Your guide is ready', 'The recording is not the asset', 'A practical next step'][index] ?? 'A useful follow-up', preview: `A short note from ${company}.`, body: `${sections[index]?.body[0] ?? ''}\n\nThe guide develops the full argument with a practical checklist.`, cta: intake.callToAction })),
    landingPage: { eyebrow: `A field guide from ${company}`, headline: 'Turn one expert insight into a decision buyers can make', subheadline: `A short guide for ${intake.audience}, built from real expert experience.`, bullets: ['Why most recordings are never used again', 'Three moves that make an idea repeatable', 'A checklist for your next recording'], formHeading: 'Get the guide', buttonLabel: 'Send me the guide' },
    sourceReferences: usesDemoSource
      ? [
        { claim: 'Expertise stays unpublished', quote: 'Most teams already have more expertise than they publish.', speaker: 'Speaker A', timestamp: '00:00' },
        { claim: 'Recordings are rarely reused', quote: '31 of them were never used again after the live session.', speaker: 'Speaker A', timestamp: '04:05' },
        { claim: 'An argument beats a summary', quote: 'An argument tells them what to do differently on Monday.', speaker: 'Speaker A', timestamp: '12:30' },
        { claim: 'Repeatability is the test', quote: 'If your account team cannot repeat the idea in one sentence, it does not exist outside the room.', speaker: 'Speaker A', timestamp: '18:40' },
      ]
      : transcript ? [{ claim: 'Primary campaign thesis', quote: demoPullQuote(transcript) ?? transcript.slice(0, 180), speaker: 'Source speaker', timestamp: '00:00' }] : [],
    carousel: {
      title: 'Your webinar is not the asset',
      slides: [
        { heading: 'The recording goes into a folder', body: 'Most expert firms give a genuinely good hour of talk to forty people, then never use it again.' },
        { heading: 'Treat it as evidence', body: 'A recording is source material to quote, test, and build on. It is not finished content.' },
        { heading: 'Name the decision', body: 'State the one choice your reader should make differently, in a single sentence.' },
        { heading: 'Show the evidence', body: 'Support it with what the expert has seen first-hand, traceable to the moment it was said.' },
        { heading: 'Make the next step small', body: 'End with an action the reader can take this week without asking for budget.' },
        { heading: 'Summaries report. Arguments decide.', body: 'Commit to one point and tell the reader what to do about it.' },
      ],
      closing: 'The full field guide has the checklist for your next recording.',
    },
  };
}

/** The built-in demo source; demo projects use it whether or not an OpenAI key is configured. */
export function demoSourceTranscript(): string { return demoTranscript; }

const demoTranscript = [
  '[00:00] Speaker A: Most teams already have more expertise than they publish. The problem is that the knowledge is trapped inside meetings, webinars, and individual conversations.',
  '[02:18] Speaker B: The useful shift is to treat a recording as source evidence rather than finished content.',
  '[04:05] Speaker A: We went back through 40 client webinars from last year. 31 of them were never used again after the live session.',
  '[06:42] Speaker A: Once the central decision is clear, every format can support the same argument without repeating the same words.',
  '[09:10] Speaker B: The teams that get this right do three things. They name the decision, they show the evidence, and they make the next step small.',
  '[12:30] Speaker A: A summary tells people what was said. An argument tells them what to do differently on Monday.',
  '[15:02] Speaker B: The buyers we interviewed did not want more content. They wanted one clear way to decide.',
  '[18:40] Speaker A: If your account team cannot repeat the idea in one sentence, it does not exist outside the room.',
].join('\n');

function createDemoProspectPreview(
  input: ProspectInput,
  brand: BrandProfile,
): { qualification: ProspectQualification; preview: ProspectPreview } {
  const sourceIdea = firstSentence(input.sourceSummary);
  const contact = input.contactName ? ` ${input.contactName.split(/\s+/)[0]}` : '';
  const likelyOffer = input.offerHint || brand.description || `expert services from ${input.companyName}`;
  return {
    qualification: {
      score: 84,
      tier: 'A',
      fitReasons: [
        'The company publishes substantial expert-led source material.',
        'The source contains a practical point of view that can support a connected campaign.',
        'The offer appears to benefit from authority-building content rather than high-volume promotion.',
      ],
      risks: input.contactEmail ? [] : ['A verified business contact email is still required before outreach.'],
      likelyAudience: 'Senior B2B decision-makers evaluating specialist expertise',
      likelyOffer,
      sourceSignal: sourceIdea,
      personalizationAngle: `Develop ${input.sourceTitle} around the decision implied by its strongest practical idea.`,
    },
    preview: {
      campaignAngle: `Turn the central idea in “${input.sourceTitle}” into a practical decision framework.`,
      guideTitle: `The Practical Guide to ${titleCase(topicFrom(input.sourceTitle))}`,
      guideSubtitle: `A focused field guide developed from ${input.companyName}'s original expertise`,
      whyNow: `${input.companyName} already has the raw material. The opportunity is to give one strong idea a clearer argument, premium presentation, and a month of coordinated distribution.`,
      sourceMoment: sourceIdea,
      articleAngles: [
        `The hidden constraint behind ${topicFrom(input.sourceTitle)}`,
        'What experienced teams notice before everyone else',
        'A practical framework buyers can use immediately',
      ],
      linkedinHooks: [
        `Most teams misunderstand ${topicFrom(input.sourceTitle)}.`,
        'A webinar is not the asset. The decision inside it is.',
        `The strongest idea in “${input.sourceTitle}” deserves more than one publication day.`,
      ],
      outreachSubject: `A campaign hidden inside ${input.sourceTitle}`,
      outreachBody: `Hi${contact},\n\nI reviewed “${input.sourceTitle}”. Its strongest campaign opening is the argument that ${lowerFirst(sourceIdea)}.\n\nI mapped that idea into a practical guide, eight LinkedIn posts, three emails, and landing-page copy. The preview is below.\n\nAfterword produces the complete package within 48 hours for $1,500/month, asynchronously.\n\nWorth turning this source into the full campaign?`,
    },
  };
}

function firstSentence(value: string): string {
  const sentence = value.trim().split(/(?<=[.!?])\s+/)[0] ?? value.trim();
  return sentence.slice(0, 240).replace(/[.!?]+$/, '');
}

function topicFrom(value: string): string {
  return value.replace(/^(webinar|podcast|workshop|keynote|interview)\s*[:\-–—]?\s*/i, '').trim();
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function lowerFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value;
}
