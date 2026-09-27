import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => { app = await createApp(); });

describe('production API', () => {
  it('reports service health and operating mode', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body.service).toBe('adforge-production-engine');
    expect(['demo', 'live']).toContain(response.body.mode);
    expect(response.body.outreach).toBe('manual');
  });

  it('prepares approved outreach for manual sending and records it once', async () => {
    const KEY = 'local-adforge-demo';
    const created = await request(app).post('/api/prospects/demo/create').set('x-adforge-key', KEY).expect(202);
    const id = created.body.id as string;
    let status = '';
    for (let attempt = 0; attempt < 50 && status !== 'preview-ready'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await request(app).get(`/api/prospects/${id}`).set('x-adforge-key', KEY).expect(200)).body.status;
    }
    expect(status).toBe('preview-ready');
    await request(app).post(`/api/prospects/${id}/mark-sent`).set('x-adforge-key', KEY).send({ confirm: true }).expect(500);
    await request(app).post(`/api/prospects/${id}/approve`).set('x-adforge-key', KEY).expect(200);
    const prepared = await request(app).post(`/api/prospects/${id}/send`).set('x-adforge-key', KEY).send({ confirm: true }).expect(200);
    expect(prepared.body.status).toBe('manual');
    expect(prepared.body.email.body).toContain('/preview/');
    await request(app).post(`/api/prospects/${id}/mark-sent`).set('x-adforge-key', KEY).send({}).expect(400);
    const sent = await request(app).post(`/api/prospects/${id}/mark-sent`).set('x-adforge-key', KEY).send({ confirm: true }).expect(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.sentAt).toBeTruthy();
    await request(app).post(`/api/prospects/${id}/mark-sent`).set('x-adforge-key', KEY).send({ confirm: true }).expect(500);
  });

  it('protects the operator project list', async () => {
    await request(app).get('/api/projects').expect(401);
    await request(app).get('/api/projects').set('x-adforge-key', 'local-adforge-demo').expect(200);
  });

  it('imports prospects from CSV while keeping the database operator-only', async () => {
    await request(app).get('/api/prospects').expect(401);
    const csv = [
      'companyName,website,contactName,contactEmail,role,country,sourceUrl,sourceTitle,sourceSummary,offerHint',
      'CSV Advisory,https://example.org,Alex Smith,alex@example.org,Partner,UK,https://example.org/webinar,Operating Better,This source explains how specialist teams turn expertise into repeatable client decisions.,Operational advisory',
    ].join('\n');
    const response = await request(app)
      .post('/api/prospects/import')
      .set('x-adforge-key', 'local-adforge-demo')
      .attach('file', Buffer.from(csv), { filename: 'prospects.csv', contentType: 'text/csv' })
      .expect(201);
    expect(response.body.created + response.body.duplicates).toBe(1);
  });
});
