import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Client, ClientCampaignRecord, ClientMemory, Intake } from './types.js';

interface ClientStoreShape { clients: Client[] }

const MAX_CAMPAIGNS = 24;
const MAX_CORRECTIONS = 40;

/** Reusable brand memory: one record per client company, carried into every monthly run. */
export class ClientStore {
  private filePath = path.join(config.dataDir, 'clients.json');
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    try { await readFile(this.filePath, 'utf8'); }
    catch { await this.write({ clients: [] }); }
  }

  async list(): Promise<Client[]> {
    return (await this.read()).clients.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Client | undefined> {
    return (await this.read()).clients.find((client) => client.id === id);
  }

  /** Finds the client for this company website, creating it on first intake, and adds new voice examples. */
  async upsertFromIntake(intake: Intake): Promise<Client> {
    const domain = clientDomain(intake.website);
    // Projects created before these fields existed have no expertName or voiceExamples.
    const examples = splitVoiceExamples(intake.voiceExamples ?? '');
    return this.mutate((data) => {
      const now = new Date().toISOString();
      let client = data.clients.find((item) => item.domain === domain);
      if (!client) {
        client = {
          id: randomUUID(), domain, companyName: intake.companyName, expertName: intake.expertName ?? '',
          memory: { terminology: [], bannedPhrases: [], voiceExamples: [], styleNotes: [] },
          campaigns: [], corrections: [], createdAt: now, updatedAt: now,
        };
        data.clients.push(client);
      }
      if (intake.expertName) client.expertName = intake.expertName;
      if (examples.length) client.memory.voiceExamples = mergeUnique(examples, client.memory.voiceExamples).slice(0, 8);
      client.updatedAt = now;
      return client;
    });
  }

  async replaceMemory(id: string, memory: ClientMemory): Promise<Client> {
    return this.change(id, (client) => { client.memory = memory; });
  }

  /** Merges learned rules into memory without dropping anything the operator entered. */
  async learn(id: string, learned: Partial<Pick<ClientMemory, 'terminology' | 'bannedPhrases' | 'styleNotes'>>): Promise<Client> {
    return this.change(id, (client) => {
      client.memory.terminology = mergeUnique(client.memory.terminology, learned.terminology ?? []).slice(0, 60);
      client.memory.bannedPhrases = mergeUnique(client.memory.bannedPhrases, learned.bannedPhrases ?? []).slice(0, 60);
      client.memory.styleNotes = mergeUnique(client.memory.styleNotes, learned.styleNotes ?? []).slice(0, 40);
    });
  }

  async addCorrection(id: string, projectId: string, note: string): Promise<Client> {
    return this.change(id, (client) => {
      client.corrections = [...client.corrections, { projectId, at: new Date().toISOString(), note }].slice(-MAX_CORRECTIONS);
    });
  }

  async recordCampaign(id: string, record: ClientCampaignRecord): Promise<Client> {
    return this.change(id, (client) => {
      client.campaigns = [...client.campaigns.filter((item) => item.projectId !== record.projectId), record].slice(-MAX_CAMPAIGNS);
    });
  }

  private async change(id: string, callback: (client: Client) => void): Promise<Client> {
    return this.mutate((data) => {
      const client = data.clients.find((item) => item.id === id);
      if (!client) throw new Error('Client not found');
      callback(client);
      client.updatedAt = new Date().toISOString();
      return client;
    });
  }

  private async read(): Promise<ClientStoreShape> {
    return JSON.parse(await readFile(this.filePath, 'utf8')) as ClientStoreShape;
  }

  private async write(data: ClientStoreShape): Promise<void> {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  private async mutate<T>(callback: (data: ClientStoreShape) => T): Promise<T> {
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

export function clientDomain(website: string): string {
  return new URL(website).hostname.toLowerCase().replace(/^www\./, '');
}

/** Splits pasted posts on blank-line-separated "---" rules or two or more blank lines. */
export function splitVoiceExamples(value: string): string[] {
  return value
    .split(/\n\s*-{3,}\s*\n|\n\s*\n\s*\n/)
    .map((example) => example.trim().slice(0, 3_000))
    .filter((example) => example.length >= 20);
}

function mergeUnique(first: string[], second: string[]): string[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
