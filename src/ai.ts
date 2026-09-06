import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import { config } from './config.js';
import {
  campaignBundleSchema,
  prospectPreviewSchema,
  prospectQualificationSchema,
  type BrandProfile,
  type CampaignBundle,
  type Intake,
  type ProspectInput,
  type ProspectPreview,
  type ProspectQualification,
} from './types.js';

const client = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : undefined;

const bundleJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['campaignAngle', 'title', 'subtitle', 'executiveSummary', 'sections', 'actionChecklist', 'linkedinPosts', 'emails', 'landingPage', 'sourceReferences'],
  properties: {
    campaignAngle: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' }, executiveSummary: { type: 'string' },
    sections: { type: 'array', minItems: 4, maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['eyebrow', 'title', 'body', 'pullQuote', 'sourceTimestamp'], properties: {
      eyebrow: { type: 'string' }, title: { type: 'string' }, body: { type: 'array', items: { type: 'string' } },
      pullQuote: { type: ['string', 'null'] }, sourceTimestamp: { type: ['string', 'null'] },
    } } },
    actionChecklist: { type: 'array', minItems: 4, maxItems: 8, items: { type: 'string' } },
    linkedinPosts: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['hook', 'body', 'cta'], properties: { hook: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } } } },
    emails: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['subject', 'preview', 'body', 'cta'], properties: { subject: { type: 'string' }, preview: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } } } },
    landingPage: { type: 'object', additionalProperties: false, required: ['eyebrow', 'headline', 'subheadline', 'bullets', 'formHeading', 'buttonLabel'], properties: {
      eyebrow: { type: 'string' }, headline: { type: 'string' }, subheadline: { type: 'string' }, bullets: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } }, formHeading: { type: 'string' }, buttonLabel: { type: 'string' },
    } },
    sourceReferences: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['claim', 'quote', 'speaker', 'timestamp'], properties: { claim: { type: 'string' }, quote: { type: 'string' }, speaker: { type: 'string' }, timestamp: { type: 'string' } } } },
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
  const response = await client.audio.transcriptions.create({
    file: createReadStream(filePath),
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

export async function generateCampaign(intake: Intake, brand: BrandProfile, transcript: string, revisionNote = ''): Promise<CampaignBundle> {
  if (!client) return createDemoBundle(intake, transcript, revisionNote);
  const response = await client.responses.create({
    model: config.contentModel,
    store: false,
    instructions: `You are the senior B2B editor inside Afterword. Turn source expertise into one coherent, commercially useful campaign. Preserve the speaker's point of view. Never invent statistics, customers, quotes, or outcomes. Every direct quote and factual claim must include a source timestamp. Use clear international English. Avoid AI clichés, inflated claims, and repetitive hooks. The result must feel edited, not summarized.`,
    input: `CLIENT\nCompany: ${intake.companyName}\nAudience: ${intake.audience}\nOffer: ${intake.offer}\nCTA: ${intake.callToAction}\nTone notes: ${intake.toneNotes || 'Clear, expert, direct'}\n\nBRAND SIGNALS\n${JSON.stringify(brand)}\n\nREVISION NOTE\n${revisionNote || 'First edition'}\n\nSOURCE TRANSCRIPT\n${transcript.slice(0, 180_000)}`,
    text: { format: { type: 'json_schema', name: 'adforge_campaign_bundle', strict: true, schema: bundleJsonSchema } },
  });
  if (!response.output_text) throw new Error('The content model returned no output');
  const parsed = JSON.parse(response.output_text) as unknown;
  const normalized = campaignBundleSchema.parse(parsed);
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

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function createDemoBundle(intake: Intake, transcript: string, revisionNote: string): CampaignBundle {
  const topic = intake.offer.split(/[.!?]/)[0] || 'expert services';
  const sectionSeeds: Array<[string, string]> = [
    ['The hidden constraint', `Most teams assume the problem is a lack of information. The source makes a stronger case: the real constraint is turning expertise into a decision people can act on.`],
    ['Make the problem observable', `The fastest progress starts by naming the current friction in practical terms. For ${intake.audience}, clarity is more useful than another broad framework.`],
    ['Build a repeatable decision', `A useful method reduces uncertainty without pretending every situation is identical. It gives the reader a sequence, a standard, and a clear next action.`],
    ['From insight to implementation', `The final step is operational. Owners, timing, and review criteria turn the idea into something a team can use rather than merely agree with.`],
    ['What to do next', `${intake.companyName} helps teams apply this thinking to ${topic.toLowerCase()}. The next conversation should begin with the situation the buyer is trying to change.`],
  ];
  const sections = sectionSeeds.map(([title, body], index) => ({
    eyebrow: `Principle ${String(index + 1).padStart(2, '0')}`,
    title,
    body: [body, `This section is generated in demo mode from the project brief. Connect an OpenAI API key to ground the final editorial version in the full source transcript.`],
    pullQuote: index === 0 ? 'Expertise becomes valuable when a buyer can recognize their own decision inside it.' : undefined,
    sourceTimestamp: transcript ? `[demo ${index + 1}:00]` : undefined,
  }));
  const hooks = [
    'Most B2B content starts too late.', 'Your webinar is not the asset.', 'A useful framework should change a decision.',
    'More information is rarely the answer.', 'The best expert content leaves fingerprints.', 'Consistency is an operational advantage.',
    'A transcript is evidence—not an article.', 'The final 10% is what earns trust.',
  ];
  return {
    campaignAngle: revisionNote ? `Revised around: ${revisionNote}` : `Turn expertise into a repeatable decision for ${intake.audience}`,
    title: `The Practical Guide to ${topic}`,
    subtitle: `A clear framework for ${intake.audience} who need to move from insight to action`,
    executiveSummary: `This guide distils one expert source into a practical argument for ${intake.audience}. It frames the core constraint, introduces a repeatable way forward, and connects the insight to ${intake.companyName}'s offer without turning the guide into a sales brochure.`,
    sections,
    actionChecklist: ['Name the decision this content should change', 'Choose one primary audience', 'Trace important claims to the source', 'Remove duplicated explanations', 'End with one proportionate next step'],
    linkedinPosts: hooks.map((hook, index) => ({ hook, body: `${sections[index % sections.length]?.body[0]}\n\nThe point is not to publish more. It is to make one valuable idea easier to understand and use.`, cta: index > 5 ? intake.callToAction : 'What does this look like inside your team?' })),
    emails: [0, 1, 2].map((index) => ({ subject: [`Your guide is ready`, `The idea worth revisiting`, `A practical next step`][index] ?? 'A useful follow-up', preview: `A concise note from ${intake.companyName}.`, body: `${sections[index]?.body[0]}\n\nThe guide develops the full argument with a practical checklist.`, cta: intake.callToAction })),
    landingPage: { eyebrow: `A practical guide from ${intake.companyName}`, headline: `Make ${topic.toLowerCase()} easier to act on`, subheadline: `A focused guide for ${intake.audience}, built from real expert insight.`, bullets: ['A clearer view of the core constraint', 'A practical framework for action', 'A checklist you can use with your team'], formHeading: 'Get the guide', buttonLabel: 'Send me the guide' },
    sourceReferences: transcript ? [{ claim: 'Primary campaign thesis', quote: transcript.slice(0, 180), speaker: 'Source speaker', timestamp: '00:00' }] : [],
  };
}

const demoTranscript = `[00:00] Speaker A: Most teams already have more expertise than they publish. The problem is that the knowledge is trapped inside meetings, webinars, and individual conversations.\n[02:18] Speaker B: The useful shift is to treat a recording as source evidence rather than finished content.\n[06:42] Speaker A: Once the central decision is clear, every format can support the same argument without repeating the same words.`;

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
