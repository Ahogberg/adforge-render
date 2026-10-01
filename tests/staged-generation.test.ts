import { afterAll, describe, expect, it, vi } from 'vitest';

const calls: Array<{ name: string; instructions: string; input: string }> = [];

const post = (index: number) => ({ hook: `Specific hook ${index}`, body: 'Post body', cta: 'Reply' });
const section = (index: number) => ({ eyebrow: `P${index}`, title: `Section ${index}`, body: ['Body'], pullQuote: null, sourceTimestamp: null });
const outputs: Record<string, unknown> = {
  adforge_source_ideas: { thesisCandidates: ['A', 'B'], ideas: [], speakerTerms: ['handover gap'] },
  adforge_campaign_plan: { thesis: 'T', campaignAngle: 'Planned angle', title: 'Planned title', subtitle: 'Planned subtitle', sections: [], postAngles: [], emailPlan: [] },
  adforge_campaign_guide: { executiveSummary: 'Summary', sections: [0, 1, 2, 3].map(section), actionChecklist: ['1', '2', '3', '4'], sourceReferences: [] },
  adforge_campaign_derivatives: {
    linkedinPosts: Array.from({ length: 8 }, (_, index) => post(index)),
    emails: Array.from({ length: 3 }, () => ({ subject: 'S', preview: 'P', body: 'B', cta: 'C' })),
    landingPage: { eyebrow: 'E', headline: 'H', subheadline: 'S', bullets: ['a', 'b', 'c'], formHeading: 'F', buttonLabel: 'Get it' },
  },
  adforge_revision_lessons: { terminology: ['Say clients, not customers'], bannedPhrases: [], styleNotes: [] },
};

// Each step is recognised by the first required field of its response schema.
const STEP_BY_FIELD: Record<string, string> = {
  thesisCandidates: 'adforge_source_ideas',
  thesis: 'adforge_campaign_plan',
  executiveSummary: 'adforge_campaign_guide',
  linkedinPosts: 'adforge_campaign_derivatives',
  terminology: 'adforge_revision_lessons',
  campaignAngle: 'adforge_campaign_bundle',
};
const requests: Array<Record<string, any>> = [];
let nextStopReason: string | undefined;

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        stream: (request: { system: string; messages: Array<{ content: string }>; output_config: { format: { schema: { required: string[] } } } }) => ({
          finalMessage: async () => {
            requests.push(request);
            const input = request.messages[0]!.content;
            const name = STEP_BY_FIELD[request.output_config.format.schema.required[0]!]!;
            calls.push({ name, instructions: request.system, input });
            if (nextStopReason) {
              const stop_reason = nextStopReason;
              nextStopReason = undefined;
              return { stop_reason, stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [] };
            }
            // The editor pass returns the draft it was given, as a faithful editor with nothing to fix would.
            const output = name === 'adforge_campaign_bundle' ? JSON.parse(input.split('\nCAMPAIGN\n')[1]!.split('\n\nSOURCE TRANSCRIPT\n')[0]!) : outputs[name];
            return { stop_reason: 'end_turn', stop_details: null, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(output) }] };
          },
        }),
      },
    };
  },
}));

vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
const { generateCampaign, repairCampaign, distilRevision, toClaudeSchema } = await import('../src/ai.js');
const { intakeSchema } = await import('../src/types.js');
afterAll(() => { vi.unstubAllEnvs(); });

const context = {
  intake: intakeSchema.parse({ companyName: 'Stage Co', contactName: 'Ann', contactEmail: 'ann@example.com', website: 'https://example.com', sourceType: 'webinar', audience: 'Partners', offer: 'Advisory', callToAction: 'Reply', expertName: 'Ann Holm' }),
  brand: { title: 'Stage', description: 'Advisory', logoUrl: '', primaryColor: '#123456', backgroundColor: '#fff', textColor: '#111', fontFamily: 'Arial', borderRadius: '4px', voiceSample: 'Website copy', sourceUrl: 'https://example.com' },
  transcript: '[00:00] Ann: The handover gap is where pricing changes die.',
  client: {
    id: 'c1', domain: 'example.com', companyName: 'Stage Co', expertName: 'Ann Holm', createdAt: '', updatedAt: '',
    memory: { terminology: ['Say clients, not customers'], bannedPhrases: ['synergy'], voiceExamples: ['I have watched forty pricing projects fail the same way.'], styleNotes: ['British spelling'] },
    campaigns: [{ projectId: 'p0', approvedAt: '2026-08-01T00:00:00.000Z', campaignAngle: 'Last month angle', title: 'Old', hooks: ['Old hook'] }],
    corrections: [{ projectId: 'p0', at: '', note: 'Never call the method a framework.' }],
  },
};

describe('staged campaign generation', () => {
  it('runs extract, plan, guide, derivatives, and editor stages with the brand memory in every brief', async () => {
    const stages: string[] = [];
    const bundle = await generateCampaign({ ...context, onStage: async (message: string) => { stages.push(message); } });
    expect(calls.map((call) => call.name)).toEqual(['adforge_source_ideas', 'adforge_campaign_plan', 'adforge_campaign_guide', 'adforge_campaign_derivatives', 'adforge_campaign_bundle']);
    expect(stages).toHaveLength(5);
    expect(bundle.title).toBe('Planned title');
    expect(bundle.linkedinPosts).toHaveLength(8);
    expect(bundle.sections[0]?.pullQuote).toBeUndefined();
    for (const call of calls) {
      expect(call.input).toContain('I have watched forty pricing projects fail');
      expect(call.input).toContain('- synergy');
      expect(call.input).toContain('Last month angle');
      expect(call.input).toContain('Never call the method a framework.');
    }
    expect(calls[3]?.instructions).toContain('first person as Ann Holm');
    expect(calls[0]?.input).toContain('The handover gap is where pricing changes die.');
  });

  it('repairs with the failed checks and the transcript in a single editor call', async () => {
    calls.length = 0;
    const draft = await generateCampaign(context);
    calls.length = 0;
    await repairCampaign(context, draft, ['Quotes verified against source: 1 of 1 quotes not found']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toContain('1 of 1 quotes not found');
    expect(calls[0]?.input).toContain('SOURCE TRANSCRIPT');
  });

  it('distils durable rules from a revision note', async () => {
    const lessons = await distilRevision('Please say clients, not customers, everywhere.', context.client.memory);
    expect(lessons.terminology).toEqual(['Say clients, not customers']);
  });

  it('calls Claude with structured output, explicit effort, and server-side fallbacks', async () => {
    const request = requests.at(-1)!;
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.fallbacks).toBe('default');
    expect(request.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(request.output_config.effort).toBe('medium');
    expect(request.output_config.format.type).toBe('json_schema');
    expect(requests[0]!.output_config.effort).toBe('high');
  });

  it('turns a classifier decline into a clear production error', async () => {
    nextStopReason = 'refusal';
    await expect(distilRevision('A note', context.client.memory)).rejects.toThrow('Claude declined the adforge_revision_lessons step (cyber)');
  });
});

describe('structured output schema', () => {
  it('drops unsupported count and range constraints and writes nullable fields as anyOf', () => {
    const schema = toClaudeSchema({
      type: 'object', additionalProperties: false, required: ['items', 'score', 'quote'],
      properties: {
        items: { type: 'array', minItems: 4, maxItems: 8, items: { type: 'string' } },
        score: { type: 'integer', minimum: 0, maximum: 100 },
        quote: { type: ['string', 'null'] },
      },
    });
    expect(schema).toEqual({
      type: 'object', additionalProperties: false, required: ['items', 'score', 'quote'],
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        score: { type: 'integer' },
        quote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    });
  });
});
