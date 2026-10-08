import { describe, expect, it, vi } from 'vitest';

const transcribeFile = vi.fn(async () => { throw new Error('demo projects must not call the transcription API'); });

vi.mock('../src/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai.js')>();
  return { ...actual, transcribeFile };
});
vi.mock('../src/render.js', () => ({ renderArtifacts: async () => ({ pdf: 'guide.pdf', landingPage: 'landing.html', deliveryZip: 'delivery.zip' }) }));
vi.mock('../src/brand.js', () => ({ scrapeBrand: async () => { throw new Error('offline'); }, closeBrowser: async () => undefined }));

const { ProductionPipeline } = await import('../src/pipeline.js');
const { ProjectStore } = await import('../src/store.js');
const { ClientStore } = await import('../src/client-store.js');
const { demoSourceTranscript } = await import('../src/ai.js');
const { intakeSchema } = await import('../src/types.js');

describe('demo projects', () => {
  it('use the built-in demo source instead of calling transcription, even with an API key set', async () => {
    const store = new ProjectStore();
    const clients = new ClientStore();
    await store.initialize();
    await clients.initialize();
    const project = await store.create(intakeSchema.parse({ companyName: 'Demo Co', contactName: 'Dee', contactEmail: 'dee@example.com', website: 'https://example.com', sourceType: 'webinar', audience: 'Partners', offer: 'Advisory', callToAction: 'Reply' }), 'demo');
    new ProductionPipeline(store, clients).enqueue(project.id);
    let status = '';
    for (let attempt = 0; attempt < 100 && !['client-review', 'failed'].includes(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await store.get(project.id))?.status ?? '';
    }
    const done = await store.get(project.id);
    expect(done?.error).toBeUndefined();
    expect(status).toBe('client-review');
    expect(done?.transcript).toBe(demoSourceTranscript());
    expect(transcribeFile).not.toHaveBeenCalled();
  });
});
