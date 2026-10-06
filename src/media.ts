import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** Thin, dependency-free wrappers around the ffmpeg and ffprobe binaries. */

let availability: Promise<boolean> | undefined;

export function ffmpegAvailable(): Promise<boolean> {
  availability ??= new Promise((resolve) => {
    const child = spawn(config.ffmpegPath, ['-hide_banner', '-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return availability;
}

/** Runs ffmpeg and rejects with the tail of its log on failure. */
export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${log.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

export interface FrameEncoder {
  write(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
  /** Stops ffmpeg without waiting; the partial output must be discarded by the caller. */
  abort(): void;
}

/** Encodes a stream of JPEG frames into an H.264 MP4 that LinkedIn and every phone can play. */
export function encodeJpegFrames(output: string, fps: number): FrameEncoder {
  const child = spawn(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    // A silent audio track: some platforms treat video without audio as a GIF and will not autoplay it with sound controls.
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  let failed: Error | undefined;
  child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); });
  child.on('error', (error) => { failed = error; });
  const closed = new Promise<void>((resolve, reject) => {
    child.on('close', (code) => (code === 0 ? resolve() : reject(failed ?? new Error(`ffmpeg exited with ${code}: ${log.trim().split('\n').slice(-3).join(' | ')}`))));
  });
  closed.catch(() => undefined);
  // If ffmpeg dies mid-stream, writes fail with EPIPE; without this listener that error crashes the process.
  child.stdin.on('error', (error) => { failed ??= error; });
  return {
    async write(frame) {
      if (failed) throw failed;
      if (!child.stdin.write(frame)) {
        await Promise.race([new Promise<void>((resolve) => child.stdin.once('drain', () => resolve())), closed.then(() => undefined)]);
        if (failed) throw failed;
      }
    },
    async finish() {
      if (!child.stdin.destroyed) child.stdin.end();
      await closed;
    },
    abort() {
      child.stdin.destroy();
      child.kill('SIGKILL');
    },
  };
}

export interface MediaInfo {
  format: string;
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export function probe(file: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffprobePath, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,width,height', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffprobe failed: ${err.trim().slice(-300)}`)); return; }
      try {
        const data = JSON.parse(out) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
        const video = data.streams?.find((stream) => stream.codec_type === 'video' && (stream.width ?? 0) > 0);
        resolve({
          format: data.format?.format_name ?? '',
          durationSeconds: Number(data.format?.duration ?? 0),
          hasVideo: Boolean(video),
          hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === 'audio')),
          width: video?.width,
          height: video?.height,
        });
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

/** Container formats ffmpeg may open from client uploads; playlists and other indirect formats are refused. */
const ALLOWED_FORMATS = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'mp3', 'wav', 'ogg', 'flac', 'aac', 'avi', 'mpeg', 'mpegts']);

/** Probes an uploaded file and refuses anything that is not a plain audio or video container. */
export async function probeUpload(file: string): Promise<MediaInfo> {
  const info = await probe(file);
  if (!info.format.split(',').some((name) => ALLOWED_FORMATS.has(name.trim()))) throw new Error(`Unsupported media format "${info.format || 'unknown'}"`);
  return info;
}

/** Speech-transcription APIs cap uploads at 25 MB; a 75-minute mono 32 kbps MP3 is about 18 MB. */
export const TRANSCRIPTION_UPLOAD_LIMIT = 24 * 1024 * 1024;

/**
 * Returns a file that is safe to send for transcription: the original when it is already a small
 * audio file, otherwise a mono 16 kHz MP3 extracted with ffmpeg.
 */
export async function prepareAudioForTranscription(file: string, workDir: string): Promise<string> {
  const size = (await stat(file)).size;
  const isAudio = /\.(mp3|m4a|wav|ogg|oga|webm|flac|mpga|mpeg)$/i.test(file);
  if (isAudio && size <= TRANSCRIPTION_UPLOAD_LIMIT) return file;
  if (!(await ffmpegAvailable())) {
    if (size > TRANSCRIPTION_UPLOAD_LIMIT) throw new Error('The source file is over 25 MB and ffmpeg is not installed to extract its audio');
    return file;
  }
  await probeUpload(file);
  await mkdir(workDir, { recursive: true });
  const output = path.join(workDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-speech.mp3`);
  await runFfmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', output]);
  return output;
}
