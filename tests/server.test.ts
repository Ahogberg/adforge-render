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
});
