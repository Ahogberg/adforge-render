import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { extractPageText } from './brand.js';
import { config } from './config.js';
import { assertPublicUrl } from './security/url.js';
import type { ProjectStore } from './store.js';
import type { Project } from './types.js';

/** Minimum amount of page text worth proposing as a source. */
const MIN_CANDIDATE_CHARS = 2_000;
const MAX_REDIRECTS = 5;

export type CaptureOutcome = 'media' | 'candidate' | 'none';

/** True when production can start: a transcript or a recording is on file. */
export function hasSource(project: Pick<Project, 'transcript' | 'sourceFile'>): boolean {
  return Boolean(project.transcript.trim() || project.sourceFile);
}

/**
 * Tries to obtain the expert source from the public URL supplied at intake.
 *
 * - A direct audio/video file is downloaded and production starts automatically.
 * - A readable page (article, published transcript, show notes) is stored as a
 *   candidate that the operator confirms from the dashboard, because page copy
 *   is not always the recording itself.
 * - Anything else leaves the project waiting for the operator.
 */
export async function captureSource(
  project: Project,
  store: ProjectStore,
  onReady: (projectId: string) => void,
): Promise<CaptureOutcome> {
  const url = project.intake.sourceUrl;
  if (!url) return 'none';
  try {
    const response = await fetchPublic(url);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (/^(audio|video)\//.test(type)) {
      const file = await downloadMedia(response, project.id, url);
      await store.update(project.id, { sourceFile: file, status: 'queued', progress: 8 }, { type: 'status', message: 'Source recording downloaded from the public URL; production queued' });
      onReady(project.id);
      return 'media';
    }
    await response.body?.cancel();
    if (!type.includes('html')) {
      await store.update(project.id, {}, { type: 'note', message: `The source URL returned ${type || 'an unknown type'}; add the recording or transcript from the dashboard.` });
      return 'none';
    }
    const page = await extractPageText(url);
    if (page.text.length < MIN_CANDIDATE_CHARS) {
      await store.update(project.id, {}, { type: 'note', message: `The source page only exposed ${page.text.length} characters of text (likely an embedded player). Add the recording or transcript from the dashboard.` });
      return 'none';
    }
    await store.update(project.id, { sourceCandidate: page.text }, { type: 'note', message: `Captured ${page.text.length} characters of text from "${page.title || url}". Confirm it is the expert source from the dashboard to start production.` });
    return 'candidate';
  } catch (error) {
    await store.update(project.id, {}, { type: 'note', message: `Automatic source capture failed: ${error instanceof Error ? error.message : String(error)}` });
    return 'none';
  }
}

/** fetch with every redirect hop validated against the SSRF rules. */
async function fetchPublic(url: string): Promise<Response> {
  let current = (await assertPublicUrl(url)).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'AdForge/2.0 (+https://adforgecreative.com)' }, signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      current = (await assertPublicUrl(new URL(response.headers.get('location') as string, current).toString())).toString();
      continue;
    }
    if (!response.ok) throw new Error(`The source URL responded with ${response.status}`);
    return response;
  }
  throw new Error('The source URL redirected too many times');
}

async function downloadMedia(response: Response, projectId: string, url: string): Promise<string> {
  if (!response.body) throw new Error('The source URL returned no content');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > config.maxUploadBytes) throw new Error('The source recording exceeds the upload limit');
  const extension = path.extname(new URL(url).pathname).slice(0, 8) || guessExtension(response.headers.get('content-type') || '');
  const destination = path.join(config.uploadDir, `${projectId}-source${extension}`);
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > config.maxUploadBytes) callback(new Error('The source recording exceeds the upload limit'));
      else callback(null, chunk);
    },
  });
  try {
    await streamPipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limiter, createWriteStream(destination));
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
  return destination;
}

function guessExtension(type: string): string {
  if (type.includes('mpeg') || type.includes('mp3')) return '.mp3';
  if (type.includes('mp4')) return '.mp4';
  if (type.includes('wav')) return '.wav';
  if (type.includes('webm')) return '.webm';
  if (type.includes('m4a')) return '.m4a';
  return '';
}
