import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { ProjectStore } from '../src/store.js';
import { ProspectStore } from '../src/prospect-store.js';
import { intakeSchema, prospectInputSchema, type CampaignBundle } from '../src/types.js';

const KEY = 'local-adforge-demo';
let app: Awaited<ReturnType<typeof createApp>>;
const projects = new ProjectStore();
const prospects = new ProspectStore();

beforeAll(async () => { app = await createApp(); });

function intakeFields(extra: Record<string, string> = {}): Record<string, string> {
  return {
    companyName: 'Gate Advisory', contactName: 'Sam Lee', contactEmail: 'sam@example.com', website: 'https://example.com',
    sourceType: 'webinar', transcript: '[00:00] Sam: Pricing changes fail in the handover, not in the partner meeting.',
    audience: 'Partners at advisory firms', offer: 'Pricing advisory', callToAction: 'Reply to start', ...extra,
  };
}

function bundle(): CampaignBundle {
  return {
    campaignAngle: 'Angle', title: 'Guide title', subtitle: 'Subtitle', executiveSummary: 'Summary',
    sections: Array.from({ length: 4 }, (_, index) => ({ eyebrow: `P${index}`, title: `Section ${index}`, body: ['Body'], pullQuote: undefined, sourceTimestamp: undefined })),
    actionChecklist: ['One', 'Two', 'Three', 'Four'],
    linkedinPosts: Array.from({ length: 8 }, (_, index) => ({ hook: `Unique LinkedIn hook ${index}`, body: 'Post body', cta: 'Comment' })),
    emails: Array.from({ length: 3 }, (_, index) => ({ subject: `Email subject ${index}`, preview: 'Preview', body: 'Email body', cta: 'Reply' })),
    landingPage: { eyebrow: 'Guide', headline: 'Landing headline copy', subheadline: 'Sub', bullets: ['A', 'B', 'C'], formHeading: 'Get it', buttonLabel: 'Send the guide' },
    sourceReferences: [],
  };
}

async function projectInReview(revisionCount = 0) {
  const project = await projects.create(intakeSchema.parse(intakeFields()), 'demo');
  return projects.update(project.id, { status: 'client-review', bundle: bundle(), quality: { score: 100, checks: [], blockers: [] }, revisionCount });
}

describe('public intake', () => {
  it('does not start paid production or expose the review link to applicants', async () => {
    let call = request(app).post('/api/intake');
    for (const [name, value] of Object.entries(intakeFields())) call = call.field(name, value);
    const response = await call.expect(202);
    expect(response.body.reviewUrl).toBeUndefined();
    const stored = await projects.get(response.body.projectId);
    expect(stored?.status).toBe('intake');
  });

  it('links an application back to the prospect whose preview referred it', async () => {
    const prospect = await prospects.create(prospectInputSchema.parse({
      companyName: 'Referral Partners', website: `https://example.com/${randomUUID()}`, contactEmail: `ref-${randomUUID()}@example.com`,
      sourceUrl: `https://example.com/${randomUUID()}`, sourceTitle: 'A useful talk', sourceSummary: 'A long enough summary of the public source material.',
    }), 'demo');
    let call = request(app).post('/api/intake');
    for (const [name, value] of Object.entries(intakeFields({ referral: prospect.previewToken }))) call = call.field(name, value);
    const response = await call.expect(202);
    expect((await projects.get(response.body.projectId))?.prospectId).toBe(prospect.id);
    const linked = await prospects.get(prospect.id);
    expect(linked?.status).toBe('qualified');
    expect(linked?.appliedProjectId).toBe(response.body.projectId);
  });
});

describe('client review', () => {
  it('shows every asset and hides internal quality checks', async () => {
    const project = await projectInReview();
    const html = (await request(app).get(`/review/${project.reviewToken}`).expect(200)).text;
    expect(html).toContain('Unique LinkedIn hook 7');
    expect(html).toContain('Email subject 2');
    expect(html).toContain('Landing headline copy');
    expect(html).not.toContain('Quality score');
    expect(html).toContain('Request one revision');
  });

  it('enforces the single consolidated revision round', async () => {
    const project = await projectInReview(1);
    await request(app).post(`/api/review/${project.reviewToken}`).type('form').send({ decision: 'revise', note: 'Change everything again' }).expect(409);
    const html = (await request(app).get(`/review/${project.reviewToken}`).expect(200)).text;
    expect(html).not.toContain('Request one revision');
    expect((await projects.get(project.id))?.status).toBe('client-review');
  });

  it('locks decisions once the campaign is approved', async () => {
    const project = await projectInReview();
    await request(app).post(`/api/review/${project.reviewToken}`).type('form').send({ decision: 'approve' }).expect(200);
    await request(app).post(`/api/review/${project.reviewToken}`).type('form').send({ decision: 'revise', note: 'Late change' }).expect(409);
    expect((await projects.get(project.id))?.status).toBe('approved');
  });
});

describe('do-not-contact list', () => {
  it('keeps an opted-out address suppressed across new sources and imports', async () => {
    const email = `optout-${randomUUID()}@example.com`;
    const first = await prospects.create(prospectInputSchema.parse({
      companyName: 'Opt Out Ltd', website: `https://example.com/${randomUUID()}`, contactEmail: email,
      sourceUrl: `https://example.com/${randomUUID()}`, sourceTitle: 'First talk', sourceSummary: 'A long enough summary of the first public source.',
    }), 'demo');
    await request(app).post(`/api/unsubscribe/${first.previewToken}`).expect(200);

    const csv = [
      'companyName,website,contactEmail,sourceUrl,sourceTitle,sourceSummary',
      `Opt Out Ltd,https://example.com/${randomUUID()},${email},https://example.com/${randomUUID()},Second talk,A long enough summary of a different public source.`,
    ].join('\n');
    const imported = await request(app).post('/api/prospects/import').set('x-adforge-key', KEY)
      .attach('file', Buffer.from(csv), { filename: 'p.csv', contentType: 'text/csv' }).expect(201);
    expect(imported.body).toMatchObject({ created: 0, suppressed: 1 });
  });

  it('suppresses a whole domain and opts out matching prospects', async () => {
    const domain = `${randomUUID().slice(0, 8)}.example.com`;
    const prospect = await prospects.create(prospectInputSchema.parse({
      companyName: 'Domain Co', website: `https://${domain}`, contactEmail: `ceo@${domain}`,
      sourceUrl: `https://${domain}/talk`, sourceTitle: 'Talk', sourceSummary: 'A long enough summary of the public source.',
    }), 'demo');
    const response = await request(app).post('/api/suppressions').set('x-adforge-key', KEY).send({ value: `@${domain}` }).expect(201);
    expect(response.body.affected).toBe(1);
    expect((await prospects.get(prospect.id))?.status).toBe('unsubscribed');
    await request(app).post(`/api/prospects/${prospect.id}/approve`).set('x-adforge-key', KEY).expect(409);
  });
});
