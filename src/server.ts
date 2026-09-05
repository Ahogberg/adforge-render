import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { closeBrowser } from './brand.js';
import { config } from './config.js';
import { isMailLive } from './mail.js';
import { ProjectNotifier } from './notifications.js';
import { sendProspectEmail } from './outreach.js';
import { ProductionPipeline } from './pipeline.js';
import { ProspectEngine } from './prospect-engine.js';
import { renderProspectPreview, renderUnsubscribePage } from './prospect-preview.js';
import { ProspectStore } from './prospect-store.js';
import { renderReviewPage } from './review.js';
import { captureSource, hasSource } from './source.js';
import { ProjectStore } from './store.js';
import { intakeSchema, prospectInputSchema, prospectStatusSchema, type ProspectInput } from './types.js';

mkdirSync(config.uploadDir, { recursive: true });
mkdirSync(config.artifactDir, { recursive: true });

const store = new ProjectStore();
const notifier = new ProjectNotifier(store);
const pipeline = new ProductionPipeline(store, notifier);
const prospectStore = new ProspectStore();
const prospectEngine = new ProspectEngine(prospectStore);
const upload = multer({
  dest: config.uploadDir,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    const allowed = /^(audio|video)\//.test(file.mimetype) || /pdf|presentation|powerpoint/.test(file.mimetype);
    if (allowed) callback(null, true);
    else callback(new Error('Only audio, video, PDF, and presentation files are accepted'));
  },
});
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

export async function createApp() {
  await store.initialize();
  await prospectStore.initialize();
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || config.allowedOrigins.includes(origin)) }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  app.get('/health', (_request, response) => response.json({
    status: 'ok',
    service: 'adforge-production-engine',
    mode: config.openaiKey ? 'live' : 'demo',
    outreach: isMailLive() ? 'live' : 'dry-run',
    notifications: isMailLive() && config.operatorEmail ? 'live' : 'dry-run',
    delivery: config.autoDeliver ? 'automatic' : 'operator-gated',
  }));

  const intakeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/api/intake', intakeLimiter, upload.single('sourceFile'), asyncHandler(async (request, response) => {
    const intake = intakeSchema.parse(normalizeIntake(request.body));
    let project = await store.create(intake, config.openaiKey ? 'live' : 'demo');
    if (request.file) project = await store.update(project.id, { sourceFile: request.file.path });
    if (project.mode === 'demo' || hasSource(project)) {
      project = await store.setStatus(project.id, 'queued', 8, 'Production queued');
      pipeline.enqueue(project.id);
    } else {
      project = await store.setStatus(project.id, 'awaiting-source', 5, 'Waiting for the source recording or transcript');
      void captureSource(project, store, (id) => pipeline.enqueue(id));
    }
    void notifier.intakeReceived(project);
    response.status(202).json({ projectId: project.id, status: project.status, reviewUrl: `${config.publicUrl}/review/${project.reviewToken}` });
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
      const approved = await store.update(project.id, { status: 'approved' }, { type: 'approval', message: 'Client approved the campaign' });
      void notifier.clientDecision(approved, 'approve');
      return response.send(successPage('Campaign approved', 'The final delivery is locked. AdForge has been notified.'));
    }
    const note = String(request.body.note || '').trim();
    if (note.length < 3) return response.status(400).send('Please include the requested changes.');
    const revising = await store.update(project.id, { status: 'revision', progress: 10, revisionNote: note }, { type: 'note', message: 'Client submitted consolidated revision notes' });
    pipeline.enqueue(project.id);
    void notifier.clientDecision(revising, 'revise', note);
    return response.send(successPage('Revision received', 'The requested changes have entered the production queue.'));
  }));

  app.get('/preview/:token', asyncHandler(async (request, response) => {
    const prospect = await prospectStore.findByToken(param(request, 'token'));
    if (!prospect || !prospect.preview || !prospect.qualification) return response.status(404).send('Campaign Preview is not available.');
    response.type('html').send(renderProspectPreview(prospect));
  }));

  app.get('/unsubscribe/:token', asyncHandler(async (request, response) => {
    const prospect = await prospectStore.findByToken(param(request, 'token'));
    if (!prospect) return response.status(404).send('This preference link is not available.');
    response.type('html').send(unsubscribeConfirmation(prospect.previewToken, prospect.input.companyName));
  }));

  app.post('/api/unsubscribe/:token', express.urlencoded({ extended: false }), asyncHandler(async (request, response) => {
    const prospect = await prospectStore.findByToken(param(request, 'token'));
    if (!prospect) return response.status(404).send('This preference link is not available.');
    await prospectStore.update(prospect.id, { status: 'unsubscribed' }, { type: 'status', message: 'Contact opted out of outreach' });
    response.type('html').send(renderUnsubscribePage(prospect.input.companyName));
  }));

  app.use('/api/prospects', operatorOnly);
  app.get('/api/prospects', asyncHandler(async (_request, response) => response.json(await prospectStore.list())));
  app.post('/api/prospects', asyncHandler(async (request, response) => {
    const input = prospectInputSchema.parse(request.body);
    response.status(201).json(await prospectStore.create(input, config.openaiKey ? 'live' : 'demo'));
  }));
  app.post('/api/prospects/import', csvUpload.single('file'), asyncHandler(async (request, response) => {
    const rows = request.file
      ? parse(request.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Array<Record<string, unknown>>
      : Array.isArray(request.body) ? request.body as Array<Record<string, unknown>> : [];
    if (!rows.length) return response.status(400).json({ error: 'Upload a CSV file or send a JSON array' });
    if (rows.length > 500) return response.status(400).json({ error: 'Import is limited to 500 prospects per batch' });
    const inputs = rows.map((row) => prospectInputSchema.parse(normalizeProspectRow(row)));
    const result = await prospectStore.createMany(inputs, config.openaiKey ? 'live' : 'demo');
    response.status(201).json({ created: result.created.length, duplicates: result.duplicates, prospectIds: result.created.map((item) => item.id) });
  }));
  app.post('/api/prospects/batch/generate', asyncHandler(async (request, response) => {
    const requested = Array.isArray(request.body.ids) ? request.body.ids.map(String) : [];
    const ids = requested.length ? requested : (await prospectStore.list()).filter((item) => ['imported', 'failed'].includes(item.status)).slice(0, 50).map((item) => item.id);
    prospectEngine.enqueueMany(ids);
    response.status(202).json({ queued: ids.length, ids });
  }));
  app.post('/api/prospects/demo/create', asyncHandler(async (_request, response) => {
    const input = prospectInputSchema.parse({
      companyName: 'Northstar Advisory', website: 'https://example.com', contactName: 'Maya Chen',
      contactEmail: 'maya@example.com', role: 'Managing Partner', country: 'United Kingdom',
      sourceUrl: 'https://example.com/webinar', sourceTitle: 'Building a Repeatable Growth Operating System',
      sourceSummary: 'Most teams already have sufficient expertise, but it remains trapped inside meetings and one-off presentations. The useful shift is to turn a source recording into decision-ready material rather than treating the transcript as finished content.',
      offerHint: 'Strategic growth advisory for expert-led companies', notes: 'Demo prospect for the complete asynchronous acquisition flow.',
    });
    const prospect = await prospectStore.create(input, 'demo');
    prospectEngine.enqueue(prospect.id);
    response.status(202).json(prospect);
  }));
  app.get('/api/prospects/:id', asyncHandler(async (request, response) => {
    const prospect = await prospectStore.get(param(request, 'id'));
    if (!prospect) return response.status(404).json({ error: 'Prospect not found' });
    response.json(prospect);
  }));
  app.post('/api/prospects/:id/generate', asyncHandler(async (request, response) => {
    const id = param(request, 'id');
    prospectEngine.enqueue(id);
    response.status(202).json({ status: 'queued' });
  }));
  app.post('/api/prospects/:id/approve', asyncHandler(async (request, response) => {
    const id = param(request, 'id');
    const prospect = await prospectStore.get(id);
    if (!prospect?.preview) return response.status(409).json({ error: 'Campaign Preview must be generated before approval' });
    if (prospect.status === 'unsubscribed') return response.status(409).json({ error: 'This contact has opted out' });
    response.json(await prospectStore.update(id, { status: 'approved', approvedAt: new Date().toISOString() }, { type: 'status', message: 'Outreach approved by operator' }));
  }));
  app.post('/api/prospects/:id/send', asyncHandler(async (request, response) => {
    if (request.body.confirm !== true) return response.status(400).json({ error: 'Explicit send confirmation is required' });
    const id = param(request, 'id');
    const prospect = await prospectStore.get(id);
    if (!prospect) return response.status(404).json({ error: 'Prospect not found' });
    const result = await sendProspectEmail(prospect);
    if (result.dryRun) {
      await prospectStore.update(id, {}, { type: 'email', message: 'Dry-run passed; configure the email provider to send' });
      return response.json({ status: 'dry-run', previewUrl: `${config.publicUrl}/preview/${prospect.previewToken}` });
    }
    response.json(await prospectStore.update(id, { status: 'sent', sentAt: new Date().toISOString(), providerMessageId: result.id }, { type: 'email', message: 'Personalized outreach sent' }));
  }));
  app.post('/api/prospects/:id/status', asyncHandler(async (request, response) => {
    const status = prospectStatusSchema.parse(request.body.status);
    if (!['replied', 'qualified', 'won', 'lost', 'unsubscribed'].includes(status)) return response.status(400).json({ error: 'This status cannot be set manually' });
    const note = String(request.body.note || '').trim();
    const conversionValue = status === 'won' ? Number(request.body.conversionValue || 1500) : undefined;
    response.json(await prospectStore.update(param(request, 'id'), { status, replyNote: note || undefined, conversionValue }, { type: status === 'won' ? 'conversion' : 'status', message: note || `Prospect marked ${status}` }));
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
    const project = await store.get(id);
    if (!project) return response.status(404).json({ error: 'Project not found' });
    if (project.mode === 'live' && !hasSource(project)) return response.status(409).json({ error: 'Add the source recording or transcript before running production' });
    await store.setStatus(id, 'queued', 8, 'Project queued by operator');
    pipeline.enqueue(id);
    response.status(202).json({ status: 'queued' });
  }));
  app.post('/api/projects/:id/source', upload.single('sourceFile'), asyncHandler(async (request, response) => {
    const id = param(request, 'id');
    const project = await store.get(id);
    if (!project) return response.status(404).json({ error: 'Project not found' });
    const transcript = String(request.body?.transcript || '').trim();
    if (!transcript && !request.file) return response.status(400).json({ error: 'Paste a transcript or upload the source recording' });
    if (transcript.length > 250_000) return response.status(400).json({ error: 'The transcript is too long' });
    const patch: Partial<typeof project> = { sourceCandidate: undefined, status: 'queued', progress: 8 };
    if (transcript) patch.transcript = transcript;
    if (request.file) patch.sourceFile = request.file.path;
    await store.update(id, patch, { type: 'status', message: request.file ? 'Source recording added by operator; production queued' : 'Transcript added by operator; production queued' });
    pipeline.enqueue(id);
    response.status(202).json({ status: 'queued' });
  }));
  app.post('/api/projects/:id/deliver', asyncHandler(async (request, response) => {
    const project = await store.get(param(request, 'id'));
    if (!project) return response.status(404).json({ error: 'Project not found' });
    if (!project.artifacts) return response.status(409).json({ error: 'The campaign has not been rendered yet' });
    const delivered = await notifier.deliverToClient(project);
    response.json({ status: delivered.deliveredAt ? 'sent' : 'dry-run', deliveredAt: delivered.deliveredAt ?? null, reviewUrl: `${config.publicUrl}/review/${project.reviewToken}` });
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

function normalizeProspectRow(row: Record<string, unknown>): Record<string, unknown> {
  const get = (...keys: string[]) => {
    const key = keys.find((candidate) => row[candidate] !== undefined);
    return key ? row[key] : '';
  };
  return {
    companyName: get('companyName', 'company', 'company_name'),
    website: get('website', 'companyWebsite', 'company_website'),
    contactName: get('contactName', 'contact', 'contact_name', 'name'),
    contactEmail: get('contactEmail', 'email', 'contact_email'),
    role: get('role', 'title', 'job_title'),
    country: get('country'),
    sourceUrl: get('sourceUrl', 'source_url', 'content_url'),
    sourceTitle: get('sourceTitle', 'source_title', 'content_title'),
    sourceSummary: get('sourceSummary', 'source_summary', 'summary', 'excerpt'),
    offerHint: get('offerHint', 'offer_hint', 'offer'),
    notes: get('notes'),
  };
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

function unsubscribeConfirmation(token: string, companyName: string): string {
  return `<!doctype html><html><body style="margin:0;background:#090a0a;color:#f4f0e8;font-family:Arial;display:grid;place-items:center;min-height:100vh;text-align:center"><main><p style="color:#e8c97a;text-transform:uppercase;letter-spacing:.12em">AdForge</p><h1>Stop outreach?</h1><p style="color:#8d918d">Confirm that we should not contact ${escapeHtml(companyName)} at this address.</p><form method="post" action="/api/unsubscribe/${encodeURIComponent(token)}"><button style="border:0;background:#e8c97a;color:#111;padding:13px 18px;font-weight:800">Confirm opt-out</button></form></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character);
}

if (process.env.NODE_ENV !== 'test') {
  const app = await createApp();
  const server = app.listen(config.port, () => console.log(`AdForge production engine running at ${config.publicUrl}`));
  const shutdown = () => { server.close(() => { void closeBrowser().finally(() => process.exit(0)); }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
