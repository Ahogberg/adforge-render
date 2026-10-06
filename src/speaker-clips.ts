import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'playwright';
import { transcribeWords, type TimedWord } from './ai.js';
import { displayQuote, escapeHtml, type DesignSystem } from './design.js';
import { ffmpegAvailable, probeUpload, runFfmpeg } from './media.js';
import { parseTimestamp, parseTranscriptSegments, type TranscriptSegment } from './quality.js';
import { expertParts, loadDocument, socialDocument, SOCIAL_HEIGHT, SOCIAL_WIDTH } from './social.js';
import type { CampaignBundle, Project, VideoArtifact } from './types.js';

const MAX_CLIPS = 2;
const MIN_SECONDS = 15;
const MAX_SECONDS = 55;
const FPS = 30;

/** Layout of the 1080x1350 frame, in pixels. */
const VIDEO_BOX = { y: 420, height: 608 };
const CAPTION_BOX = { y: 1052, height: 140 };
const PROGRESS_Y = 1204;

export interface ClipWindow {
  start: number;
  end: number;
  headline: string;
  quote: string;
  timestamp: string;
}

export interface Caption { start: number; end: number; text: string }

/**
 * Picks up to two non-overlapping windows around verified quotes: pull quotes first (the
 * strongest lines in the guide), then the source references.
 */
export function planSpeakerClips(bundle: CampaignBundle, transcript: string, mediaDuration: number): ClipWindow[] {
  const segments = parseTranscriptSegments(transcript);
  if (!segments.length) return [];
  const candidates = [
    ...bundle.sections.filter((section) => section.pullQuote).map((section) => ({ quote: section.pullQuote as string, headline: section.title, timestamp: section.sourceTimestamp })),
    ...bundle.sourceReferences.map((reference) => ({ quote: reference.quote, headline: reference.claim, timestamp: reference.timestamp })),
  ];
  const windows: ClipWindow[] = [];
  for (const candidate of candidates) {
    if (windows.length >= MAX_CLIPS) break;
    const index = locateQuote(segments, candidate.quote, candidate.timestamp);
    if (index < 0) continue;
    const window = expandWindow(segments, index, candidate.quote, mediaDuration);
    if (!window) continue;
    if (windows.some((existing) => window.start < existing.end && existing.start < window.end)) continue;
    windows.push({ ...window, headline: candidate.headline, quote: candidate.quote, timestamp: formatClock(segments[index]?.start ?? window.start) });
  }
  return windows;
}

function normalizeWords(value: string): string[] {
  return value.toLowerCase().replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
}

function locateQuote(segments: TranscriptSegment[], quote: string, timestamp?: string): number {
  const words = normalizeWords(quote);
  const at = parseTimestamp(timestamp);
  const texts = segments.map((segment) => ` ${normalizeWords(segment.text).join(' ')} `);
  // Longer probes first: a short, common opening ("and the thing is") can match the wrong passage.
  for (const length of [8, 6, 4]) {
    if (words.length < Math.min(length, 4)) continue;
    const probeWords = ` ${words.slice(0, Math.min(length, words.length)).join(' ')} `;
    const matches = texts.map((text, index) => (text.includes(probeWords) ? index : -1)).filter((index) => index >= 0);
    if (!matches.length) continue;
    if (at === undefined) return matches[0] as number;
    return matches.reduce((best, index) => (Math.abs((segments[index]?.start ?? 0) - at) < Math.abs((segments[best]?.start ?? 0) - at) ? index : best), matches[0] as number);
  }
  if (at === undefined) return -1;
  let best = -1;
  segments.forEach((segment, index) => { if (segment.start <= at + 1) best = index; });
  return best;
}

function expandWindow(segments: TranscriptSegment[], index: number, quote: string, mediaDuration: number): { start: number; end: number } | undefined {
  const first = segments[index];
  if (!first) return undefined;
  const quoteTail = normalizeWords(quote).slice(-3).join(' ');
  const start = Math.max(0, first.start - 0.3);
  let end = Math.min(first.end, start + MAX_SECONDS);
  let reachedQuoteEnd = ` ${normalizeWords(first.text).join(' ')} `.includes(` ${quoteTail} `);
  for (let next = index + 1; next < segments.length; next += 1) {
    const segment = segments[next] as TranscriptSegment;
    if (reachedQuoteEnd && end - start >= MIN_SECONDS) break;
    if (segment.end - start > MAX_SECONDS) break;
    end = segment.end;
    if (!reachedQuoteEnd) reachedQuoteEnd = ` ${normalizeWords(segment.text).join(' ')} `.includes(` ${quoteTail} `);
  }
  end = Math.min(mediaDuration > 0 ? mediaDuration : end, end + 0.4);
  return end - start >= 6 ? { start, end } : undefined;
}

/** Splits timed words into short caption lines that read comfortably on a phone. */
export function chunkCaptions(words: TimedWord[], clipDuration: number): Caption[] {
  const captions: Caption[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (!current.length) return;
    captions.push({ start: current[0]?.start ?? 0, end: current[current.length - 1]?.end ?? 0, text: current.map((word) => word.word).join(' ').replace(/\s+([,.!?;:])/g, '$1') });
    current = [];
  };
  for (const word of words) {
    const text = [...current, word].map((item) => item.word).join(' ');
    // Up to two balanced lines; prefer breaking at punctuation.
    if (current.length && (text.length > 62 || current.length >= 11)) flush();
    current.push(word);
    if (/[.!?;:]$/.test(word.word) || (/[,]$/.test(word.word) && current.length >= 5)) flush();
  }
  flush();
  // Never leave one or two words alone on screen: fold them into the previous caption when it fits.
  for (let index = captions.length - 1; index > 0; index -= 1) {
    const caption = captions[index] as Caption;
    const previous = captions[index - 1] as Caption;
    if (caption.text.split(/\s+/).length <= 2 && `${previous.text} ${caption.text}`.length <= 74 && caption.start - previous.end < 0.8) {
      captions.splice(index - 1, 2, { start: previous.start, end: caption.end, text: `${previous.text} ${caption.text}` });
    }
  }
  // Each caption stays up until the next one starts, so the frame is never briefly empty mid-sentence.
  return captions.map((caption, index) => {
    const next = captions[index + 1];
    const end = next && next.start - caption.end < 1.2 ? next.start : Math.min(clipDuration, caption.end + 0.5);
    const lasting = Math.max(caption.start + 0.4, end);
    // between() includes both ends, so stop just before the next caption to avoid two on screen at once.
    return { ...caption, start: Math.max(0, caption.start), end: next ? Math.min(lasting, next.start - 0.01) : lasting };
  });
}

/** Without word timings (demo mode), spread each segment's words evenly over its time span. */
export function estimateWords(segments: TranscriptSegment[], window: { start: number; end: number }): TimedWord[] {
  const words: TimedWord[] = [];
  for (const segment of segments) {
    if (segment.end <= window.start || segment.start >= window.end) continue;
    const tokens = segment.text.split(/\s+/).filter(Boolean);
    const span = Math.max(0.5, segment.end - segment.start - 0.3);
    const totalChars = tokens.reduce((sum, token) => sum + token.length + 1, 0);
    let cursor = segment.start;
    for (const token of tokens) {
      const duration = span * ((token.length + 1) / totalChars);
      const start = cursor - window.start;
      cursor += duration;
      if (start >= 0 && start < window.end - window.start) words.push({ word: token, start, end: cursor - window.start });
    }
  }
  return words;
}

export async function renderSpeakerClips(browser: Browser, project: Project, design: DesignSystem, directory: string): Promise<{ clips: VideoArtifact[]; notes: string[] }> {
  if (!project.bundle) return { clips: [], notes: [] };
  if (!project.sourceFile) return { clips: [], notes: ['No recording was uploaded, so no clips were cut from it. Upload the audio or video file to get captioned clips.'] };
  if (!(await ffmpegAvailable())) return { clips: [], notes: ['Clips from the recording skipped: ffmpeg is not installed on this server.'] };
  const info = await probeUpload(project.sourceFile);
  if (!info.hasAudio) return { clips: [], notes: ['The uploaded source has no audio track, so no clips were cut from it.'] };
  const windows = planSpeakerClips(project.bundle, project.transcript, info.durationSeconds);
  if (!windows.length) return { clips: [], notes: ['No verified quote could be located in the timestamped transcript, so no clips were cut.'] };

  const outDir = path.join(directory, 'clips');
  const workDir = path.join(outDir, '.work');
  await mkdir(workDir, { recursive: true });
  const segments = parseTranscriptSegments(project.transcript);
  const kind: VideoArtifact['kind'] = info.hasVideo ? 'speaker' : 'audiogram';
  const clips: VideoArtifact[] = [];
  const notes: string[] = [];
  const page = await browser.newPage({ viewport: { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT }, deviceScaleFactor: 1 });
  try {
    for (const [index, window] of windows.entries()) {
      try {
        const name = `${kind === 'speaker' ? 'speaker' : 'audio'}-clip-${String(index + 1).padStart(2, '0')}`;
        const duration = window.end - window.start;
        const clipAudio = path.join(workDir, `${name}.mp3`);
        await runFfmpeg(['-ss', window.start.toFixed(2), '-t', duration.toFixed(2), '-i', project.sourceFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', clipAudio]);
        let words = await transcribeWords(clipAudio).catch((error: unknown) => {
          notes.push(`Word timings unavailable for ${name}; captions use estimated timing (${error instanceof Error ? error.message : String(error)}).`);
          return undefined;
        });
        if (!words?.length) words = estimateWords(segments, window);
        const captions = chunkCaptions(words, duration);

        const background = path.join(workDir, `${name}-frame.png`);
        await loadDocument(page, socialDocument(design, frameHtml(project, window, kind), FRAME_CSS));
        await page.screenshot({ path: background });
        const captionFiles: string[] = [];
        await page.setViewportSize({ width: SOCIAL_WIDTH, height: CAPTION_BOX.height });
        for (const [captionIndex, caption] of captions.entries()) {
          const file = path.join(workDir, `${name}-caption-${String(captionIndex).padStart(3, '0')}.png`);
          await loadDocument(page, socialDocument(design, `<div class="cap fit" data-max="52" data-min="38">${escapeHtml(caption.text)}</div>`, CAPTION_CSS));
          await page.screenshot({ path: file, omitBackground: true });
          captionFiles.push(file);
        }
        await page.setViewportSize({ width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT });

        const file = path.join(outDir, `${name}.mp4`);
        const partial = path.join(workDir, `${name}.mp4`);
        await composeClip({ source: project.sourceFile, background, captions, captionFiles, window, output: partial, kind, waveColor: design.palette.accentOnDark, progressColor: design.palette.accentOnDark });
        await rename(partial, file);
        const poster = path.join(outDir, `${name}.poster.jpg`);
        await runFfmpeg(['-ss', Math.min(2, duration / 2).toFixed(2), '-i', file, '-frames:v', '1', '-q:v', '4', poster]);
        clips.push({ file, poster, kind, title: window.headline, durationSeconds: Math.round(duration * 10) / 10, sourceStart: window.start, sourceEnd: window.end });
      } catch (error) {
        await page.setViewportSize({ width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT }).catch(() => undefined);
        notes.push(`Clip ${index + 1} from the recording could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await page.close();
    await rm(workDir, { recursive: true, force: true });
  }
  return { clips, notes };
}

interface ComposeInput {
  source: string;
  background: string;
  captions: Caption[];
  captionFiles: string[];
  window: ClipWindow;
  output: string;
  kind: VideoArtifact['kind'];
  waveColor: string;
  progressColor: string;
}

async function composeClip(input: ComposeInput): Promise<void> {
  const duration = input.window.end - input.window.start;
  const ffColor = (hex: string) => `0x${hex.replace('#', '')}`;
  const args = ['-loop', '1', '-framerate', String(FPS), '-i', input.background, '-ss', input.window.start.toFixed(2), '-t', duration.toFixed(2), '-i', input.source];
  for (const file of input.captionFiles) args.push('-i', file);
  const filters: string[] = [];
  if (input.kind === 'speaker') {
    filters.push(`[1:v]scale=${SOCIAL_WIDTH}:${VIDEO_BOX.height}:force_original_aspect_ratio=decrease,pad=${SOCIAL_WIDTH}:${VIDEO_BOX.height}:(ow-iw)/2:(oh-ih)/2:color=0x000000,setsar=1,fps=${FPS}[media]`);
    filters.push('[1:a]anull[speech]');
  } else {
    filters.push('[1:a]asplit=2[speech][wavesrc]');
    filters.push(`[wavesrc]showwaves=s=${SOCIAL_WIDTH - 192}x${VIDEO_BOX.height - 200}:mode=cline:draw=full:rate=${FPS}:scale=sqrt:colors=${ffColor(input.waveColor)},format=rgba,pad=${SOCIAL_WIDTH}:${VIDEO_BOX.height}:96:100:color=0x00000000[media]`);
  }
  filters.push(`[0:v][media]overlay=0:${VIDEO_BOX.y}:shortest=1[v0]`);
  let last = 'v0';
  input.captions.forEach((caption, index) => {
    const next = `v${index + 1}`;
    filters.push(`[${last}][${index + 2}:v]overlay=0:${CAPTION_BOX.y}:enable='between(t,${caption.start.toFixed(2)},${caption.end.toFixed(2)})'[${next}]`);
    last = next;
  });
  // A thin progress line along the footer rule, like a native player.
  const track = `${SOCIAL_WIDTH - 192}x4`;
  const seconds = duration.toFixed(2);
  filters.push(`color=c=black@0:s=${track}:r=${FPS}:d=${seconds},format=rgba[track]`);
  filters.push(`color=c=${ffColor(input.progressColor)}:s=${track}:r=${FPS}:d=${seconds},format=rgba[fill]`);
  filters.push(`[track][fill]overlay=x='-w+w*t/${seconds}':y=0:shortest=1[progress]`);
  filters.push(`[${last}][progress]overlay=96:${PROGRESS_Y}:shortest=1[barred]`);
  filters.push(`[barred]fade=t=in:st=0:d=0.35,fade=t=out:st=${Math.max(0, duration - 0.45).toFixed(2)}:d=0.45,format=yuv420p[vout]`);
  filters.push(`[speech]loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.2,afade=t=out:st=${Math.max(0, duration - 0.45).toFixed(2)}:d=0.45[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', duration.toFixed(2), '-movflags', '+faststart', input.output);
  await runFfmpeg(args);
}

const FRAME_CSS = `
.frame{position:relative;width:${SOCIAL_WIDTH}px;height:${SOCIAL_HEIGHT}px;background:var(--dark);color:var(--on-dark);overflow:hidden}
.glow{position:absolute;inset:0;background:radial-gradient(900px 600px at 88% 4%,color-mix(in srgb,var(--accent-on-dark) 14%,transparent),transparent 62%)}
.abs{position:absolute;left:96px;right:96px}
.topbar{top:96px;display:flex;justify-content:space-between;color:var(--muted-on-dark)}
.topbar b{color:var(--on-dark);font-weight:600}
.topline{top:150px;height:3px;background:var(--accent-on-dark)}
.headline{top:194px;max-height:196px;font-size:64px;line-height:1.08}
.media{left:0;right:0;top:${VIDEO_BOX.y}px;height:${VIDEO_BOX.height}px;background:#000}
.media.audio{background:color-mix(in srgb,var(--on-dark) 4%,var(--dark))}
.footline{top:${PROGRESS_Y}px;height:4px;background:var(--rule-on-dark);border-radius:2px}
.foot{top:1236px;display:flex;justify-content:space-between;align-items:center}
.who strong{display:block;font:600 34px/1.2 var(--font-text)}
.who span{display:block;margin-top:6px;font:500 25px/1.3 var(--font-text);color:var(--muted-on-dark)}
.src{display:flex;align-items:center;gap:12px;color:var(--muted-on-dark)}
.src i{width:12px;height:12px;border-radius:50%;background:var(--accent-on-dark)}
`;

const CAPTION_CSS = `
html,body{background:transparent!important}
.cap{width:${SOCIAL_WIDTH}px;height:${CAPTION_BOX.height}px;max-height:${CAPTION_BOX.height}px;padding:0 80px;display:block;text-align:center;font:650 52px/1.2 var(--font-text);color:var(--on-dark);text-wrap:balance;text-shadow:0 2px 18px rgba(0,0,0,.35)}
`;

function frameHtml(project: Project, window: ClipWindow, kind: VideoArtifact['kind']): string {
  const expert = expertParts(project);
  return `<div class="frame"><div class="glow"></div>
    <div class="abs topbar label"><span><b>${escapeHtml(project.intake.companyName)}</b></span><span>From the ${escapeHtml(project.intake.sourceType)}</span></div>
    <div class="abs topline"></div>
    <div class="abs headline display fit" data-max="64" data-min="44">${escapeHtml(window.headline || displayQuote(window.quote))}</div>
    <div class="abs media ${kind === 'audiogram' ? 'audio' : ''}"></div>
    <div class="abs footline"></div>
    <div class="abs foot"><div class="who"><strong>${escapeHtml(expert.name)}</strong>${expert.role ? `<span>${escapeHtml(expert.role)}</span>` : ''}</div><span class="src label"><i></i>Source · ${escapeHtml(window.timestamp)}</span></div>
  </div>`;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60).toString().padStart(2, '0');
  const secs = (whole % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`;
}
