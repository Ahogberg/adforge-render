import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Prospect, ProspectEvent, ProspectInput, ProspectStatus } from './types.js';

interface ProspectStoreShape { prospects: Prospect[] }

export class ProspectStore {
  private filePath = path.join(config.dataDir, 'prospects.json');
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    try { await readFile(this.filePath, 'utf8'); }
    catch { await this.write({ prospects: [] }); }
  }

  async list(): Promise<Prospect[]> {
    return (await this.read()).prospects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Prospect | undefined> {
    return (await this.read()).prospects.find((prospect) => prospect.id === id);
  }

  async findByToken(token: string): Promise<Prospect | undefined> {
    return (await this.read()).prospects.find((prospect) => prospect.previewToken === token);
  }

  async findByEmail(email: string): Promise<Prospect | undefined> {
    const normalized = email.trim().toLowerCase();
    return (await this.read()).prospects.find((prospect) => prospect.input.contactEmail.toLowerCase() === normalized);
  }

  async create(input: ProspectInput, mode: Prospect['mode']): Promise<Prospect> {
    const duplicate = await this.findDuplicate(input.website, input.sourceUrl);
    if (duplicate) return duplicate;
    const prospect = buildProspect(input, mode);
    return this.mutate((data) => { data.prospects.push(prospect); return prospect; });
  }

  async createMany(inputs: ProspectInput[], mode: Prospect['mode']): Promise<{ created: Prospect[]; duplicates: number }> {
    return this.mutate((data) => {
      const known = new Set(data.prospects.map((prospect) => duplicateKey(prospect.input.website, prospect.input.sourceUrl)));
      const created: Prospect[] = [];
      let duplicates = 0;
      for (const input of inputs) {
        const key = duplicateKey(input.website, input.sourceUrl);
        if (known.has(key)) { duplicates += 1; continue; }
        known.add(key);
        const prospect = buildProspect(input, mode);
        data.prospects.push(prospect);
        created.push(prospect);
      }
      return { created, duplicates };
    });
  }

  async update(id: string, patch: Partial<Prospect>, event?: Omit<ProspectEvent, 'id' | 'at'>): Promise<Prospect> {
    return this.mutate((data) => {
      const prospect = data.prospects.find((item) => item.id === id);
      if (!prospect) throw new Error('Prospect not found');
      Object.assign(prospect, patch, { updatedAt: new Date().toISOString() });
      if (event) prospect.events.push({ id: randomUUID(), at: new Date().toISOString(), ...event });
      return prospect;
    });
  }

  async setStatus(id: string, status: ProspectStatus, message: string): Promise<Prospect> {
    return this.update(id, { status }, { type: 'status', message });
  }

  private async findDuplicate(website: string, sourceUrl: string): Promise<Prospect | undefined> {
    const site = normalizeUrl(website);
    const source = normalizeUrl(sourceUrl);
    return (await this.read()).prospects.find((prospect) =>
      normalizeUrl(prospect.input.website) === site && normalizeUrl(prospect.input.sourceUrl) === source,
    );
  }

  private async read(): Promise<ProspectStoreShape> {
    return JSON.parse(await readFile(this.filePath, 'utf8')) as ProspectStoreShape;
  }

  private async write(data: ProspectStoreShape): Promise<void> {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  private async mutate<T>(callback: (data: ProspectStoreShape) => T): Promise<T> {
    let result!: T;
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const data = await this.read();
      result = callback(data);
      await this.write(data);
    });
    await this.writeChain;
    return result;
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
}

function duplicateKey(website: string, sourceUrl: string): string {
  return `${normalizeUrl(website)}::${normalizeUrl(sourceUrl)}`;
}

function buildProspect(input: ProspectInput, mode: Prospect['mode']): Prospect {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    previewToken: randomBytes(24).toString('base64url'),
    input,
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    mode,
    events: [{ id: randomUUID(), at: now, type: 'status', message: 'Prospect imported' }],
  };
}
