import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClientStore, splitVoiceExamples } from '../src/client-store.js';
import { inspectCampaign } from '../src/quality.js';
import { createApp } from '../src/server.js';
import { ProjectStore } from '../src/store.js';
import { intakeSchema, type CampaignBundle } from '../src/types.js';

const KEY = 'local-adforge-demo';
const clients = new ClientStore();
const projects = new ProjectStore();
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => { app = await createApp(); });

function intake(domain: string, extra: Record<string, string> = {}) {
  return intakeSchema.parse({
    companyName: 'Memory Partners', contactName: 'Kim', contactEmail: `kim@${domain}`, website: `https://www.${domain}/about`,
    sourceType: 'podcast', audience: 'Operations leaders', offer: 'Advisory', callToAction: 'Reply', ...extra,
  });
}

function bundle(): CampaignBundle {
  return {
    campaignAngle: 'Handover beats strategy', title: 'The Handover Guide', subtitle: 'Sub', executiveSummary: 'Summary',
    sections: Array.from({ length: 4 }, (_, index) => ({ eyebrow: `P${index}`, title: `Section ${index}`, body: ['Body copy about clients.'], pullQuote: undefined, sourceTimestamp: undefined })),
    actionChecklist: ['One', 'Two', 'Three', 'Four'],
    linkedinPosts: Array.from({ length: 8 }, (_, index) => ({ hook: `Hook ${index}`, body: 'Post', cta: 'Reply' })),
    emails: Array.from({ length: 3 }, (_, index) => ({ subject: `Subject ${index}`, preview: 'P', body: 'B', cta: 'C' })),
    landingPage: { eyebrow: 'E', headline: 'H', subheadline: 'S', bullets: ['A', 'B', 'C'], formHeading: 'F', buttonLabel: 'Get it' },
    sourceReferences: [],
  };
}

describe('client brand memory', () => {
  it('keeps one client per company domain and accumulates voice examples', async () => {
    const domain = `${randomUUID().slice(0, 8)}.example.com`;
    const first = await clients.upsertFromIntake(intake(domain, { expertName: 'Kim Berg', voiceExamples: 'First post from Kim about handovers and pricing.\n---\nSecond post from Kim about account teams.' }));
    const second = await clients.upsertFromIntake(intake(domain, { voiceExamples: 'Third post from Kim about renewals and reasons.' }));
    expect(second.id).toBe(first.id);
    expect(second.domain).toBe(domain);
    expect(second.expertName).toBe('Kim Berg');
    expect(second.memory.voiceExamples).toHaveLength(3);
  });

  it('splits pasted posts on rules or double blank lines', () => {
    expect(splitVoiceExamples('Post one is long enough to count.\n\n\nPost two is long enough to count.\n---\nshort')).toHaveLength(2);
  });

  it('merges learned rules without duplicates', async () => {
    const client = await clients.upsertFromIntake(intake(`${randomUUID().slice(0, 8)}.example.com`));
    await clients.learn(client.id, { terminology: ['Say client, not customer'], bannedPhrases: ['synergy'] });
    const updated = await clients.learn(client.id, { terminology: ['say client, not customer'], bannedPhrases: ['Leverage'] });
    expect(updated.memory.terminology).toEqual(['Say client, not customer']);
    expect(updated.memory.bannedPhrases).toEqual(['synergy', 'Leverage']);
  });

  it('blocks a delivery that uses a phrase the client banned and warns on generic phrasing', () => {
    const draft = bundle();
    draft.linkedinPosts[2]!.body = 'Our Synergy model is a game-changer.';
    const report = inspectCampaign(draft, '', { bannedPhrases: ['synergy'] });
    expect(report.blockers).toContain('Client banned phrases');
    expect(report.checks.find((check) => check.name === 'No generic AI phrasing')?.status).toBe('warning');
    expect(inspectCampaign(draft, '', { bannedPhrases: ['syn'] }).blockers).not.toContain('Client banned phrases');
  });

  it('records revisions and approved campaigns on the client', async () => {
    const domain = `${randomUUID().slice(0, 8)}.example.com`;
    const client = await clients.upsertFromIntake(intake(domain));
    const created = await projects.create(intake(domain), 'demo');
    const project = await projects.update(created.id, { clientId: client.id, status: 'client-review', bundle: bundle(), quality: { score: 100, checks: [], blockers: [] } });

    await request(app).post(`/api/projects/${project.id}/approve`).set('x-adforge-key', KEY).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await clients.get(client.id);
    expect(stored?.campaigns.map((item) => item.campaignAngle)).toEqual(['Handover beats strategy']);
    expect(stored?.campaigns[0]?.hooks).toHaveLength(8);
  });

  it('lets the operator edit memory through the API with validation', async () => {
    const client = await clients.upsertFromIntake(intake(`${randomUUID().slice(0, 8)}.example.com`));
    await request(app).put(`/api/clients/${client.id}/memory`).set('x-adforge-key', KEY).send({ terminology: ['x'.repeat(400)] }).expect(400);
    const response = await request(app).put(`/api/clients/${client.id}/memory`).set('x-adforge-key', KEY)
      .send({ terminology: ['Say partners, not consultants'], bannedPhrases: ['best-in-class'], voiceExamples: [], styleNotes: ['British spelling'] }).expect(200);
    expect(response.body.memory.bannedPhrases).toEqual(['best-in-class']);
    await request(app).get('/api/clients').expect(401);
  });
});

describe('legacy projects', () => {
  it('builds memory for an intake stored before voice fields existed', async () => {
    const legacy = { ...intake(`${randomUUID().slice(0, 8)}.example.com`) } as Record<string, unknown>;
    delete legacy.voiceExamples;
    delete legacy.expertName;
    const client = await clients.upsertFromIntake(legacy as ReturnType<typeof intake>);
    expect(client.memory.voiceExamples).toEqual([]);
    expect(client.expertName).toBe('');
  });
});
