import path from 'node:path';

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: integer(process.env.PORT, 3001),
  operatorKey: process.env.ADFORGE_OPERATOR_KEY || 'local-adforge-demo',
  allowedOrigins: (process.env.ADFORGE_ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicUrl: process.env.ADFORGE_PUBLIC_URL || 'http://localhost:3001',
  openaiKey: process.env.OPENAI_API_KEY || '',
  contentModel: process.env.OPENAI_CONTENT_MODEL || 'gpt-5.6-luna',
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe-diarize',
  dataDir: path.resolve(process.cwd(), 'data'),
  uploadDir: path.resolve(process.cwd(), 'uploads'),
  artifactDir: path.resolve(process.cwd(), 'artifacts'),
  templateDir: path.resolve(process.cwd(), 'templates'),
  maxUploadBytes: 600 * 1024 * 1024,
  maxConcurrentJobs: Math.max(1, integer(process.env.ADFORGE_JOB_CONCURRENCY, 1)),
};

if (process.env.NODE_ENV === 'production' && config.operatorKey === 'local-adforge-demo') {
  throw new Error('ADFORGE_OPERATOR_KEY must be set in production');
}
