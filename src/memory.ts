import { distilRevision } from './ai.js';
import type { ClientStore } from './client-store.js';
import type { ProjectStore } from './store.js';
import type { Project } from './types.js';

/** Stores the revision note and distils durable rules from it into the client's brand memory. */
export async function rememberRevision(clients: ClientStore, projects: ProjectStore, project: Project, note: string): Promise<void> {
  if (!project.clientId) return;
  const client = await clients.addCorrection(project.clientId, project.id, note);
  const lessons = await distilRevision(note, client.memory);
  const learned = lessons.terminology.length + lessons.bannedPhrases.length + lessons.styleNotes.length;
  if (!learned) return;
  await clients.learn(client.id, lessons);
  const summary = [...lessons.terminology, ...lessons.bannedPhrases.map((phrase) => `never “${phrase}”`), ...lessons.styleNotes].join('; ');
  await projects.update(project.id, {}, { type: 'note', message: `Brand memory learned ${learned} rule${learned === 1 ? '' : 's'}: ${summary}` });
}

/** Records the approved angle and hooks so future months do not repeat them. */
export async function rememberApproval(clients: ClientStore, project: Project): Promise<void> {
  if (!project.clientId || !project.bundle) return;
  await clients.recordCampaign(project.clientId, {
    projectId: project.id,
    approvedAt: project.approvedAt ?? new Date().toISOString(),
    campaignAngle: project.bundle.campaignAngle,
    title: project.bundle.title,
    hooks: project.bundle.linkedinPosts.map((post) => post.hook),
  });
}
