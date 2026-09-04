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
