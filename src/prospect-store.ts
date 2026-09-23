import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Prospect, ProspectEvent, ProspectInput, ProspectStatus } from './types.js';

interface ProspectStoreShape { prospects: Prospect[]; suppressions?: string[] }

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
    if (isSuppressed(await this.read(), input.contactEmail)) throw new SuppressedContactError();
    const duplicate = await this.findDuplicate(input.website, input.sourceUrl);
    if (duplicate) return duplicate;
    const prospect = buildProspect(input, mode);
    return this.mutate((data) => { data.prospects.push(prospect); return prospect; });
  }

  async createMany(inputs: ProspectInput[], mode: Prospect['mode']): Promise<{ created: Prospect[]; duplicates: number; suppressed: number }> {
    return this.mutate((data) => {
      const known = new Set(data.prospects.map((prospect) => duplicateKey(prospect.input.website, prospect.input.sourceUrl)));
      const created: Prospect[] = [];
      let duplicates = 0;
      let suppressed = 0;
      for (const input of inputs) {
        if (isSuppressed(data, input.contactEmail)) { suppressed += 1; continue; }
        const key = duplicateKey(input.website, input.sourceUrl);
        if (known.has(key)) { duplicates += 1; continue; }
        known.add(key);
        const prospect = buildProspect(input, mode);
        data.prospects.push(prospect);
        created.push(prospect);
      }
      return { created, duplicates, suppressed };
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

  async isSuppressed(email: string): Promise<boolean> {
    return isSuppressed(await this.read(), email);
  }

  async listSuppressions(): Promise<string[]> {
    return (await this.read()).suppressions ?? [];
  }

  /**
   * Adds an email address or a whole domain ("example.com" or "@example.com") to the
   * do-not-contact list and opts out every matching prospect that has not converted.
   */
  async suppress(value: string, reason: string): Promise<{ entry: string; affected: number }> {
    const entry = normalizeSuppression(value);
    return this.mutate((data) => {
      data.suppressions = [...new Set([...(data.suppressions ?? []), entry])];
      let affected = 0;
      for (const prospect of data.prospects) {
        if (!matchesSuppression(entry, prospect.input.contactEmail) || ['won', 'unsubscribed'].includes(prospect.status)) continue;
        const now = new Date().toISOString();
        prospect.status = 'unsubscribed';
        prospect.updatedAt = now;
        prospect.events.push({ id: randomUUID(), at: now, type: 'status', message: reason });
        affected += 1;
      }
      return { entry, affected };
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

export class SuppressedContactError extends Error {
  constructor() { super('This contact is on the do-not-contact list'); }
}

function normalizeSuppression(value: string): string {
  const entry = value.trim().toLowerCase().replace(/^@/, '');
  if (!/^[^\s@]+(@[^\s@]+)?\.[^\s@]+$/.test(entry)) throw new Error('Provide an email address or a domain');
  return entry;
}

function matchesSuppression(entry: string, email: string): boolean {
  const address = email.trim().toLowerCase();
  if (!address) return false;
  return entry.includes('@') ? address === entry : address.endsWith(`@${entry}`);
}

function isSuppressed(data: ProspectStoreShape, email: string): boolean {
  return (data.suppressions ?? []).some((entry) => matchesSuppression(entry, email));
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
