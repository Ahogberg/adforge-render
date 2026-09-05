import path from 'node:path';

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

const storageDir = path.resolve(process.env.ADFORGE_STORAGE_DIR || process.cwd());

export const config = {
  port: integer(process.env.PORT, 3001),
  operatorKey: process.env.ADFORGE_OPERATOR_KEY || 'local-adforge-demo',
  allowedOrigins: (process.env.ADFORGE_ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicUrl: (process.env.ADFORGE_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, ''),
  marketingUrl: (process.env.ADFORGE_MARKETING_URL || 'https://adforgecreative.com').replace(/\/$/, ''),
  openaiKey: process.env.OPENAI_API_KEY || '',
  contentModel: process.env.OPENAI_CONTENT_MODEL || 'gpt-5.6-luna',
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe-diarize',
  storageDir,
  dataDir: path.join(storageDir, 'data'),
  uploadDir: path.join(storageDir, 'uploads'),
  artifactDir: path.join(storageDir, 'artifacts'),
  templateDir: path.resolve(process.cwd(), 'templates'),
  maxUploadBytes: 600 * 1024 * 1024,
  maxConcurrentJobs: Math.max(1, integer(process.env.ADFORGE_JOB_CONCURRENCY, 1)),
  maxConcurrentProspects: Math.max(1, integer(process.env.ADFORGE_PROSPECT_CONCURRENCY, 2)),
  resendKey: process.env.RESEND_API_KEY || '',
  // One verified sender is used for every email the engine sends: client notifications and prospect outreach.
  outreachFrom: process.env.ADFORGE_OUTREACH_FROM || '',
  outreachReplyTo: process.env.ADFORGE_OUTREACH_REPLY_TO || '',
  // Where operator notifications go (new applications, campaigns ready for a check, client decisions, failures).
  operatorEmail: process.env.ADFORGE_OPERATOR_EMAIL || '',
  // When true, the client receives the review link as soon as the quality gate passes.
  // When false (default), the operator checks the campaign first and releases it from the dashboard.
  autoDeliver: flag(process.env.ADFORGE_AUTO_DELIVER),
};

if (process.env.NODE_ENV === 'production' && config.operatorKey === 'local-adforge-demo') {
  throw new Error('ADFORGE_OPERATOR_KEY must be set in production');
}
