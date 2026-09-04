import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import type { Intake, Project, ProjectEvent, ProjectStatus } from './types.js';

interface StoreShape { projects: Project[] }

export class ProjectStore {
  private filePath = path.join(config.dataDir, 'projects.json');
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    try { await readFile(this.filePath, 'utf8'); }
    catch { await this.write({ projects: [] }); }
  }

  private async read(): Promise<StoreShape> {
    return JSON.parse(await readFile(this.filePath, 'utf8')) as StoreShape;
  }

  private async write(data: StoreShape): Promise<void> {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  private async mutate<T>(callback: (data: StoreShape) => T): Promise<T> {
    let result!: T;
    this.writeChain = this.writeChain.then(async () => {
      const data = await this.read();
      result = callback(data);
      await this.write(data);
    });
    await this.writeChain;
    return result;
  }

  async list(): Promise<Project[]> {
    return (await this.read()).projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project | undefined> {
    return (await this.read()).projects.find((project) => project.id === id);
  }

  async create(intake: Intake, mode: Project['mode']): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(), intake, status: 'intake', progress: 5,
      createdAt: now, updatedAt: now, transcript: intake.transcript,
      reviewToken: randomBytes(24).toString('base64url'),
      events: [{ id: randomUUID(), at: now, type: 'status', message: 'Project intake received' }],
      mode,
    };
    return this.mutate((data) => { data.projects.push(project); return project; });
  }

  async update(id: string, patch: Partial<Project>, event?: Omit<ProjectEvent, 'id' | 'at'>): Promise<Project> {
    return this.mutate((data) => {
      const project = data.projects.find((item) => item.id === id);
      if (!project) throw new Error('Project not found');
      Object.assign(project, patch, { updatedAt: new Date().toISOString() });
      if (event) project.events.push({ id: randomUUID(), at: new Date().toISOString(), ...event });
      return project;
    });
  }

  async setStatus(id: string, status: ProjectStatus, progress: number, message: string): Promise<Project> {
    return this.update(id, { status, progress }, { type: 'status', message });
  }
}
