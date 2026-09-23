import { scrapeBrand } from './brand.js';
import { config } from './config.js';
import { generateCampaign, repairCampaign, transcribeFile, type CampaignContext } from './ai.js';
import { ClientStore } from './client-store.js';
import { inspectCampaign } from './quality.js';
import { renderArtifacts } from './render.js';
import { ProjectStore } from './store.js';
import type { BrandProfile, Project, QualityReport } from './types.js';

const MAX_REPAIR_ATTEMPTS = 1;

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

  constructor(private readonly store: ProjectStore, private readonly clients: ClientStore) {}

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

      // Brand memory: every run reads the client's accumulated rules, voice, and history.
      const client = await this.clients.upsertFromIntake(project.intake);
      if (project.clientId !== client.id) project = await this.store.update(projectId, { clientId: client.id });

      await this.store.setStatus(projectId, 'writing', 52, 'Developing the guide and campaign assets');
      const context: CampaignContext = {
        intake: project.intake, brand, transcript, revisionNote: project.revisionNote, client,
        onStage: (message) => this.store.update(projectId, {}, { type: 'status', message }),
      };
      let bundle = await generateCampaign(context);
      project = await this.store.update(projectId, { bundle });

      await this.store.setStatus(projectId, 'quality-check', 72, 'Checking completeness, source coverage, and consistency');
      let quality: QualityReport = inspectCampaign(bundle, transcript, client.memory);
      for (let attempt = 1; quality.blockers.length && attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
        const failures = quality.checks.filter((check) => check.status === 'fail').map((check) => `${check.name}: ${check.detail}`);
        await this.store.update(projectId, { quality }, { type: 'note', message: `Quality gate failed; repairing. ${failures.join(' ')}` });
        bundle = await repairCampaign(context, bundle, failures);
        project = await this.store.update(projectId, { bundle });
        quality = inspectCampaign(bundle, transcript, client.memory);
      }
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
