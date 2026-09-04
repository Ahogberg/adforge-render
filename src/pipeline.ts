import { scrapeBrand } from './brand.js';
import { config } from './config.js';
import { generateCampaign, transcribeFile } from './ai.js';
import { inspectCampaign } from './quality.js';
import { renderArtifacts } from './render.js';
import { ProjectStore } from './store.js';
import type { BrandProfile, Project } from './types.js';

type Task = () => Promise<void>;

class WorkQueue {
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

export class ProductionPipeline {
  private queue = new WorkQueue(config.maxConcurrentJobs);
  private enqueued = new Set<string>();

  constructor(private readonly store: ProjectStore) {}

  enqueue(projectId: string): void {
    if (this.enqueued.has(projectId)) return;
    this.enqueued.add(projectId);
    this.queue.add(async () => {
      try { await this.run(projectId); }
      finally { this.enqueued.delete(projectId); }
    });
  }

  private async run(projectId: string): Promise<void> {
    try {
      let project = await this.requireProject(projectId);
      await this.store.setStatus(projectId, 'transcribing', 16, 'Preparing and transcribing the source');
      let transcript = project.transcript;
      if (!transcript && project.sourceFile) transcript = await transcribeFile(project.sourceFile);
      if (!transcript) {
        if (project.mode === 'demo') transcript = await transcribeFile('demo');
        else throw new Error('A source upload or transcript is required before production can begin');
      }
      project = await this.store.update(projectId, { transcript });

      await this.store.setStatus(projectId, 'extracting', 32, 'Extracting brand and source signals');
      let brand: BrandProfile;
      try { brand = await scrapeBrand(project.intake.website, project.intake.primaryColor); }
      catch (error) {
        brand = fallbackBrand(project);
        await this.store.update(projectId, { brand }, { type: 'note', message: `Brand URL could not be read automatically; safe fallback profile applied (${messageOf(error)}).` });
      }
      project = await this.store.update(projectId, { brand });

      await this.store.setStatus(projectId, 'writing', 52, 'Developing the guide and campaign assets');
      const bundle = await generateCampaign(project.intake, brand, transcript, project.revisionNote);
      project = await this.store.update(projectId, { bundle });

      await this.store.setStatus(projectId, 'quality-check', 72, 'Checking completeness, source coverage, and consistency');
      const quality = inspectCampaign(bundle);
      if (quality.blockers.length) throw new Error(`Quality gate failed: ${quality.blockers.join(', ')}`);
      project = await this.store.update(projectId, { quality });

      await this.store.setStatus(projectId, 'rendering', 88, 'Rendering the premium guide and delivery package');
      const artifacts = await renderArtifacts(project);
      await this.store.update(projectId, { artifacts, status: 'client-review', progress: 100, error: undefined }, { type: 'status', message: 'Campaign ready for one consolidated review' });
    } catch (error) {
      await this.store.update(projectId, { status: 'failed', error: messageOf(error) }, { type: 'error', message: messageOf(error) });
    }
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.store.get(id);
    if (!project) throw new Error('Project not found');
    return project;
  }
}

function fallbackBrand(project: Project): BrandProfile {
  return {
    title: project.intake.companyName,
    description: project.intake.offer,
    logoUrl: '',
    primaryColor: project.intake.primaryColor,
    backgroundColor: '#ffffff',
    textColor: '#171717',
    fontFamily: 'Arial, sans-serif',
    borderRadius: '4px',
    voiceSample: project.intake.toneNotes,
    sourceUrl: project.intake.website,
  };
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
