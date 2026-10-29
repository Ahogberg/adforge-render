import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
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

  it('is view-only until paid: guide as page images, no PDFs, then unlocks downloads', async () => {
    const project = await projectInReview();
    const dir = path.join(config.artifactDir, project.id);
    await mkdir(path.join(dir, 'linkedin'), { recursive: true });
    await mkdir(path.join(dir, 'review-pages'), { recursive: true });
    const file = (name: string) => path.join(dir, name);
    await Promise.all(['premium-guide.pdf', 'linkedin/carousel.pdf', 'review-pages/guide-page-01.jpg', 'linkedin/post-01.png', 'linkedin/carousel-slide-01.png', 'secret.json'].map((name) => writeFile(file(name), `fixture ${name}`)));
    await projects.update(project.id, { artifacts: {
      pdf: file('premium-guide.pdf'), landingPage: file('landing.html'), deliveryZip: file('delivery.zip'),
      carouselPdf: file('linkedin/carousel.pdf'), guidePages: [file('review-pages/guide-page-01.jpg')],
      postCards: [file('linkedin/post-01.png')], carouselSlides: [file('linkedin/carousel-slide-01.png')],
      motionClips: [{ file: file('quote-clip-01.mp4'), poster: file('quote-clip-01.poster.jpg'), title: 'A quote', kind: 'quote', durationSeconds: 9 }],
    } });
    const review = `/review/${project.reviewToken}`;
    let html = (await request(app).get(review).expect(200)).text;
    expect(html).toContain(`${review}/assets/post-01.png`);
    expect(html).toContain(`${review}/assets/guide-page-01.jpg`);
    expect(html).not.toContain('Open the designed guide (PDF)');
    expect(html).toContain('controlslist="nodownload"');
    expect(html).toContain('LinkedIn carousel');
    expect(html).toContain('Quote clip');
    const served = await request(app).get(`${review}/assets/post-01.png`).expect(200);
    expect(served.headers['cache-control']).toContain('private');
    await request(app).get(`${review}/assets/guide-page-01.jpg`).expect(200);
    await request(app).get(`${review}/assets/premium-guide.pdf`).expect(404);
    await request(app).get(`${review}/assets/carousel.pdf`).expect(404);
    await request(app).get(`${review}/assets/secret.json`).expect(404);
    await request(app).get(`${review}/assets/..%2Fsecret.json`).expect(404);
    await request(app).get(`/review/wrong-token/assets/post-01.png`).expect(404);

    await request(app).post(`/api/projects/${project.id}/mark-paid`).expect(401);
    const paid = await request(app).post(`/api/projects/${project.id}/mark-paid`).set('x-adforge-key', KEY).expect(200);
    expect(paid.body.paidAt).toBeTruthy();
    html = (await request(app).get(review).expect(200)).text;
    expect(html).toContain('Open the designed guide (PDF)');
    expect(html).not.toContain('controlslist="nodownload"');
    await request(app).get(`${review}/assets/premium-guide.pdf`).expect(200);
    await request(app).get(`${review}/assets/carousel.pdf`).expect(200);
  });

  it('shows the editorial brief and the publishing plan, with downloads only after payment', async () => {
    const project = await projectInReview();
    const dir = path.join(config.artifactDir, project.id);
    await mkdir(dir, { recursive: true });
    const file = (name: string) => path.join(dir, name);
    await Promise.all(['premium-guide.pdf', 'editorial-brief-and-plan.pdf', 'publishing-plan.ics'].map((name) => writeFile(file(name), `fixture ${name}`)));
    await projects.update(project.id, {
      bundle: { ...project.bundle!, editorialBrief: { strongestIdeas: [{ idea: 'Approval is not the finish', why: 'It is backed by a figure.' }], angleRationale: 'Partners need the handover, not the model.', leftOut: [{ idea: 'Pricing software', why: 'Off-audience.' }] } },
      artifacts: { pdf: file('premium-guide.pdf'), landingPage: file('landing.html'), deliveryZip: file('delivery.zip'), briefPdf: file('editorial-brief-and-plan.pdf'), publishingPlanIcs: file('publishing-plan.ics'),
        publishingPlan: [{ week: 1, date: '2026-11-09', weekday: 'Monday', channel: 'Email', title: 'Email 1: deliver the guide', detail: 'Subject: Your guide' }] },
    });
    const review = `/review/${project.reviewToken}`;
    let html = (await request(app).get(review).expect(200)).text;
    expect(html).toContain('Why we chose this angle');
    expect(html).toContain('Approval is not the finish');
    expect(html).toContain('Left out, on purpose');
    expect(html).toContain('30-day publishing plan');
    expect(html).toContain('Email 1: deliver the guide');
    expect(html).not.toContain('publishing-plan.ics');
    await request(app).get(`${review}/assets/editorial-brief-and-plan.pdf`).expect(404);
    await request(app).post(`/api/projects/${project.id}/mark-paid`).set('x-adforge-key', KEY).expect(200);
    html = (await request(app).get(review).expect(200)).text;
    expect(html).toContain(`${review}/assets/publishing-plan.ics`);
    await request(app).get(`${review}/assets/editorial-brief-and-plan.pdf`).expect(200);
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
