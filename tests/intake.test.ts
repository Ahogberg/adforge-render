import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Force live mode before the server module loads so URL-only intake must wait for a source,
// and replace the real pipeline so no browser or model call runs inside the test.
const enqueued = vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key-never-called';
  return { ids: [] as string[] };
});
vi.mock('../src/pipeline.js', () => ({
  ProductionPipeline: class { enqueue(id: string) { enqueued.ids.push(id); } },
}));

import { createApp } from '../src/server.js';

let app: Awaited<ReturnType<typeof createApp>>;
const key = { 'x-adforge-key': 'local-adforge-demo' };
const application = {
  companyName: 'Northstar Advisory', contactName: 'Maya Chen', contactEmail: 'maya@example.com',
  website: 'https://example.com', sourceType: 'webinar', audience: 'Operations leaders at professional-services firms',
  offer: 'Operational advisory', callToAction: 'Book a 30-minute assessment', startTiming: 'this-month', priceConfirmed: 'on',
};

beforeAll(async () => { app = await createApp(); });

describe('live intake without a source', () => {
  it('parks the project until a recording or transcript exists, and records the notifications', async () => {
    const created = await request(app).post('/api/intake').send(application).expect(202);
    expect(created.body.status).toBe('awaiting-source');
    expect(created.body.reviewUrl).toContain('/review/');
    expect(enqueued.ids).not.toContain(created.body.projectId);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const project = (await request(app).get(`/api/projects/${created.body.projectId}`).set(key).expect(200)).body;
    expect(project.status).toBe('awaiting-source');
    expect(project.mode).toBe('live');
    const emails = project.events.filter((event: { type: string }) => event.type === 'email').map((event: { message: string }) => event.message);
    expect(emails.some((message: string) => message.includes('client-intake') && message.includes('maya@example.com'))).toBe(true);
    expect(emails.some((message: string) => message.includes('operator-intake'))).toBe(true);
  });

  it('refuses to run production and to add an empty source', async () => {
    const created = await request(app).post('/api/intake').send(application).expect(202);
    await request(app).post(`/api/projects/${created.body.projectId}/run`).set(key).expect(409);
    await request(app).post(`/api/projects/${created.body.projectId}/source`).set(key).expect(400);
    await request(app).post(`/api/projects/${created.body.projectId}/deliver`).set(key).expect(409);
  });

  it('accepts a pasted transcript and queues production', async () => {
    const created = await request(app).post('/api/intake').send(application).expect(202);
    const response = await request(app)
      .post(`/api/projects/${created.body.projectId}/source`)
      .set(key)
      .field('transcript', '[00:00] Speaker A: Most teams already have more expertise than they publish.')
      .expect(202);
    expect(response.body.status).toBe('queued');
    expect(enqueued.ids).toContain(created.body.projectId);
    const project = (await request(app).get(`/api/projects/${created.body.projectId}`).set(key).expect(200)).body;
    expect(project.status).toBe('queued');
    expect(project.transcript).toContain('Speaker A');
  });
});
