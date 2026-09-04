import { generateProspectPreview } from './ai.js';
import { scrapeBrand } from './brand.js';
import { config } from './config.js';
import { ProspectStore } from './prospect-store.js';
import type { BrandProfile, Prospect } from './types.js';

type Task = () => Promise<void>;

class ProspectQueue {
  private active = 0;
  private waiting: Task[] = [];

  constructor(private readonly concurrency: number) {}

  add(task: Task): void {
    this.waiting.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const task = this.waiting.shift();
      if (!task) return;
      this.active += 1;
      void task().finally(() => { this.active -= 1; this.drain(); });
    }
  }
}

export class ProspectEngine {
  private queue = new ProspectQueue(config.maxConcurrentProspects);
  private enqueued = new Set<string>();

  constructor(private readonly store: ProspectStore) {}

  enqueue(prospectId: string): void {
    if (this.enqueued.has(prospectId)) return;
    this.enqueued.add(prospectId);
    this.queue.add(async () => {
      try { await this.run(prospectId); }
      finally { this.enqueued.delete(prospectId); }
    });
  }

  enqueueMany(prospectIds: string[]): void {
    for (const id of prospectIds.slice(0, 50)) this.enqueue(id);
  }

  private async run(prospectId: string): Promise<void> {
    try {
      let prospect = await this.requireProspect(prospectId);
      if (['sent', 'won', 'unsubscribed'].includes(prospect.status)) {
        throw new Error(`Prospect cannot be regenerated while status is ${prospect.status}`);
      }
      await this.store.setStatus(prospectId, 'researching', 'Researching company and source signals');
      let brand: BrandProfile;
      try { brand = await scrapeBrand(prospect.input.website, '#E8C97A'); }
      catch (error) {
        brand = fallbackBrand(prospect);
        await this.store.update(prospectId, { brand }, { type: 'note', message: `Website signals unavailable; safe brief fallback used (${messageOf(error)}).` });
      }
      prospect = await this.store.update(prospectId, { brand });
      const generated = await generateProspectPreview(prospect.input, brand);
      await this.store.update(
        prospectId,
        { qualification: generated.qualification, preview: generated.preview, status: 'preview-ready', error: undefined },
        { type: 'status', message: `Campaign Preview ready — tier ${generated.qualification.tier}, ${generated.qualification.score}/100` },
      );
    } catch (error) {
      await this.store.update(prospectId, { status: 'failed', error: messageOf(error) }, { type: 'error', message: messageOf(error) });
    }
  }

  private async requireProspect(id: string): Promise<Prospect> {
    const prospect = await this.store.get(id);
    if (!prospect) throw new Error('Prospect not found');
    return prospect;
  }
}

function fallbackBrand(prospect: Prospect): BrandProfile {
  return {
    title: prospect.input.companyName,
    description: prospect.input.offerHint,
    logoUrl: '',
    primaryColor: '#E8C97A',
    backgroundColor: '#ffffff',
    textColor: '#171717',
    fontFamily: 'Arial, sans-serif',
    borderRadius: '4px',
    voiceSample: prospect.input.notes,
    sourceUrl: prospect.input.website,
  };
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
