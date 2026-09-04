import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import { closeBrowser } from './brand.js';
import { config } from './config.js';
import { ProductionPipeline } from './pipeline.js';
import { renderReviewPage } from './review.js';
import { ProjectStore } from './store.js';
import { intakeSchema } from './types.js';

mkdirSync(config.uploadDir, { recursive: true });
mkdirSync(config.artifactDir, { recursive: true });

const store = new ProjectStore();
const pipeline = new ProductionPipeline(store);
const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    const allowed = /^(audio|video)\//.test(file.mimetype) || /pdf|presentation|powerpoint/.test(file.mimetype);
    if (allowed) callback(null, true);
    else callback(new Error('Only audio, video, PDF, and presentation files are accepted'));
  },
});

export async function createApp() {
  await store.initialize();
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || config.allowedOrigins.includes(origin)) }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  app.get('/health', (_request, response) => response.json({ status: 'ok', service: 'adforge-production-engine', mode: config.openaiKey ? 'live' : 'demo' }));

  const intakeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/api/intake', intakeLimiter, upload.single('sourceFile'), asyncHandler(async (request, response) => {
    const intake = intakeSchema.parse(normalizeIntake(request.body));
    const project = await store.create(intake, config.openaiKey ? 'live' : 'demo');
    if (request.file) await store.update(project.id, { sourceFile: request.file.path });
    pipeline.enqueue(project.id);
    response.status(202).json({ projectId: project.id, status: 'queued', reviewUrl: `${config.publicUrl}/review/${project.reviewToken}` });
  }));

  app.get('/review/:token', asyncHandler(async (request, response) => {
    const project = (await store.list()).find((item) => item.reviewToken === request.params.token);
    if (!project || !project.bundle || !project.quality) return response.status(404).send('Review is not available yet.');
    response.type('html').send(renderReviewPage(project));
  }));

  app.post('/api/review/:token', intakeLimiter, asyncHandler(async (request, response) => {
    const project = (await store.list()).find((item) => item.reviewToken === request.params.token);
    if (!project) return response.status(404).send('Project not found');
    const decision = request.body.decision === 'approve' ? 'approve' : 'revise';
    if (decision === 'approve') {
      await store.update(project.id, { status: 'approved' }, { type: 'approval', message: 'Client approved the campaign' });
      return response.send(successPage('Campaign approved', 'The final delivery is locked. AdForge has been notified.'));
    }
    const note = String(request.body.note || '').trim();
    if (note.length < 3) return response.status(400).send('Please include the requested changes.');
    await store.update(project.id, { status: 'revision', progress: 10, revisionNote: note }, { type: 'note', message: 'Client submitted consolidated revision notes' });
    pipeline.enqueue(project.id);
    return response.send(successPage('Revision received', 'The requested changes have entered the production queue.'));
  }));

  app.use('/api/projects', operatorOnly);
  app.get('/api/projects', asyncHandler(async (_request, response) => response.json(await store.list())));
  app.get('/api/projects/:id', asyncHandler(async (request, response) => {
    const project = await store.get(param(request, 'id'));
    if (!project) return response.status(404).json({ error: 'Project not found' });
    response.json(project);
  }));
  app.post('/api/projects/:id/run', asyncHandler(async (request, response) => {
    const id = param(request, 'id');
    await store.setStatus(id, 'queued', 8, 'Project queued by operator');
    pipeline.enqueue(id);
    response.status(202).json({ status: 'queued' });
  }));
  app.post('/api/projects/:id/approve', asyncHandler(async (request, response) => {
    response.json(await store.update(param(request, 'id'), { status: 'approved' }, { type: 'approval', message: 'Campaign approved by operator' }));
  }));
  app.post('/api/projects/:id/revise', asyncHandler(async (request, response) => {
    const note = String(request.body.note || '').trim();
    if (note.length < 3) return response.status(400).json({ error: 'Revision note is required' });
    const id = param(request, 'id');
    await store.update(id, { status: 'revision', progress: 10, revisionNote: note }, { type: 'note', message: 'Operator submitted a consolidated revision' });
    pipeline.enqueue(id);
    response.status(202).json({ status: 'revision' });
  }));
  app.get('/api/projects/:id/download/:kind', asyncHandler(async (request, response) => {
    const project = await store.get(param(request, 'id'));
    const kind = param(request, 'kind') as 'pdf' | 'landingPage' | 'deliveryZip';
    const file = project?.artifacts?.[kind];
    if (!file) return response.status(404).json({ error: 'Artifact not found' });
    response.download(file);
  }));
  app.post('/api/projects/demo/create', asyncHandler(async (_request, response) => {
    const intake = intakeSchema.parse({ companyName: 'Northstar Advisory', contactName: 'Maya Chen', contactEmail: 'maya@example.com', website: 'https://example.com', sourceType: 'webinar', sourceUrl: 'https://example.com/webinar', transcript: '', audience: 'B2B leaders building a repeatable growth operating system', offer: 'Strategic growth advisory for expert-led companies', callToAction: 'Book a 30-minute operating-system review', toneNotes: 'Clear, commercially sharp, pragmatic, never breathless', primaryColor: '#D09B45' });
    const project = await store.create(intake, 'demo');
    pipeline.enqueue(project.id);
    response.status(202).json(project);
  }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = 'issues' in Object(error) ? 400 : 500;
    if (status === 500) console.error(error);
    response.status(status).json({ error: message });
  });
  return app;
}

function operatorOnly(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.header('x-adforge-key') || '';
  const expected = config.operatorKey;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    response.status(401).json({ error: 'Operator authentication required' }); return;
  }
  next();
}

function normalizeIntake(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, transcript: body.transcript || '', toneNotes: body.toneNotes || '', primaryColor: body.primaryColor || '#E8C97A' };
}

function param(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string') throw new Error(`Missing route parameter: ${name}`);
  return value;
}

function asyncHandler(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => { void handler(request, response, next).catch(next); };
}

function successPage(title: string, message: string): string {
  return `<!doctype html><html><body style="margin:0;background:#090a0a;color:#f4f0e8;font-family:Arial;display:grid;place-items:center;min-height:100vh;text-align:center"><main><p style="color:#e8c97a;text-transform:uppercase;letter-spacing:.12em">AdForge</p><h1>${title}</h1><p style="color:#8d918d">${message}</p></main></body></html>`;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await createApp();
  const server = app.listen(config.port, () => console.log(`AdForge production engine running at ${config.publicUrl}`));
  const shutdown = () => { server.close(() => { void closeBrowser().finally(() => process.exit(0)); }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
