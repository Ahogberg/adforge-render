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
import { ClientStore } from './client-store.js';
import { rememberApproval, rememberRevision } from './memory.js';
import { config } from './config.js';
import { notifyOperator, sendApplicationEmails } from './notifications.js';
import { sendProspectEmail } from './outreach.js';
import { ProductionPipeline } from './pipeline.js';
import { ProspectEngine } from './prospect-engine.js';
import { renderProspectPreview, renderUnsubscribePage } from './prospect-preview.js';
import { ProspectStore, SuppressedContactError } from './prospect-store.js';
import { CLIENT_REVISION_ROUNDS, renderReviewPage } from './review.js';
import { ProjectStore } from './store.js';
import { clientMemorySchema, intakeSchema, prospectInputSchema, prospectStatusSchema, type Project, type ProspectInput } from './types.js';

mkdirSync(config.uploadDir, { recursive: true });
mkdirSync(config.artifactDir, { recursive: true });

const store = new ProjectStore();
const clientStore = new ClientStore();
const pipeline = new ProductionPipeline(store, clientStore);
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
  await clientStore.initialize();
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
    outreach: config.resendKey && config.outreachFrom ? 'live' : 'dry-run',
  }));

  const intakeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/api/intake', intakeLimiter, upload.single('sourceFile'), asyncHandler(async (request, response) => {
    const intake = intakeSchema.parse(normalizeIntake(request.body));
    let project = await store.create(intake, config.openaiKey ? 'live' : 'demo');
    if (request.file) project = await store.update(project.id, { sourceFile: request.file.path });
    project = await linkReferral(project);
    // Public applications wait for the operator to confirm fit and payment before any paid
    // production runs. Only the authenticated dashboard starts production immediately.
    const operator = isOperator(request);
    if (operator) {
      await store.setStatus(project.id, 'queued', 8, 'Project queued by operator');
      pipeline.enqueue(project.id);
    }
    void sendApplicationEmails(project).catch((error: unknown) => console.error('Application email failed:', error));
    response.status(202).json(operator
      ? { projectId: project.id, status: 'queued', reviewUrl: `${config.publicUrl}/review/${project.reviewToken}` }
      : { projectId: project.id, status: 'received' });
  }));

  app.get('/review/:token', asyncHandler(async (request, response) => {
    const project = (await store.list()).find((item) => item.reviewToken === request.params.token);
    if (!project || !project.bundle || !project.quality) return response.status(404).send('Review is not available yet.');
    response.type('html').send(renderReviewPage(project));
  }));

  app.post('/api/review/:token', intakeLimiter, asyncHandler(async (request, response) => {
    const project = (await store.list()).find((item) => item.reviewToken === request.params.token);
    if (!project) return response.status(404).send('Project not found');
    if (project.status !== 'client-review') {
      return response.status(409).send(successPage('Nothing to decide right now', project.status === 'approved' ? 'This campaign is already approved and locked.' : 'Your campaign is being updated. We will email you when it is ready to review.'));
    }
    const decision = request.body.decision === 'approve' ? 'approve' : 'revise';
    if (decision === 'approve') {
      const approved = await store.update(project.id, { status: 'approved', approvedAt: new Date().toISOString() }, { type: 'approval', message: 'Client approved the campaign' });
      remember(rememberApproval(clientStore, approved));
      alertOperator(`Approved · ${project.intake.companyName}`, [`${project.intake.contactName} approved the campaign.`, `Dashboard: ${config.publicUrl}/`], `afterword-client-approved-${project.id}`);
      return response.send(successPage('Campaign approved', 'The final delivery is locked. Afterword has been notified.'));
    }
    const revisionsUsed = project.revisionCount ?? 0;
    if (revisionsUsed >= CLIENT_REVISION_ROUNDS) return response.status(409).send(successPage('Revision round used', 'This month includes one consolidated revision. Approve the campaign, or reply to our email if a factual error remains.'));
    const note = String(request.body.note || '').trim();
    if (note.length < 3) return response.status(400).send('Please include the requested changes.');
    await store.update(project.id, { status: 'revision', progress: 10, revisionNote: note, revisionCount: revisionsUsed + 1 }, { type: 'note', message: 'Client submitted consolidated revision notes' });
    remember(rememberRevision(clientStore, store, project, note));
    pipeline.enqueue(project.id);
    alertOperator(`Revision requested · ${project.intake.companyName}`, [`${project.intake.contactName} requested the consolidated revision:`, '', note], `afterword-client-revision-${project.id}-${revisionsUsed + 1}`);
    return response.send(successPage('Revision received', 'The requested changes have entered the production queue. We will email you when the revised campaign is ready.'));
  }));

  app.get('/preview/:token', asyncHandler(async (request, response) => {
    const prospect = await prospectStore.findByToken(param(request, 'token'));
    if (!prospect || !prospect.preview || !prospect.qualification) return response.status(404).send('Campaign Preview is not available.');
    response.type('html').send(renderProspectPreview(prospect));
    void recordPreviewView(prospect.id).catch((error: unknown) => console.error('Preview view tracking failed:', error));
  }));

  app.get('/unsubscribe/:token', asyncHandler(async (request, response) => {
    const prospect = await prospectStore.findByToken(param(request, 'token'));
    if (!prospect) return response.status(404).send('This preference link is not available.');
    response.type('html').send(unsubscribeConfirmation(prospect.previewToken, prospect.input.companyName));
  }));

  app.post('/api/unsubscribe/:token', express.urlencoded({ extended: false }), asyncHandler(async (request, response) => {
    const prospect = await prospectStore.findByToken(param(request, 'token'));
    if (!prospect) return response.status(404).send('This preference link is not available.');
    if (prospect.input.contactEmail) await prospectStore.suppress(prospect.input.contactEmail, 'Contact opted out of outreach');
    if (prospect.status !== 'unsubscribed') await prospectStore.update(prospect.id, { status: 'unsubscribed' }, { type: 'status', message: 'Contact opted out of outreach' });
    response.type('html').send(renderUnsubscribePage(prospect.input.companyName));
  }));

  app.use('/api/prospects', operatorOnly);
  app.get('/api/prospects', asyncHandler(async (_request, response) => response.json(await prospectStore.list())));
  app.post('/api/prospects', asyncHandler(async (request, response) => {
    const input = prospectInputSchema.parse(request.body);
    try { response.status(201).json(await prospectStore.create(input, config.openaiKey ? 'live' : 'demo')); }
    catch (error) {
      if (error instanceof SuppressedContactError) return response.status(409).json({ error: error.message });
      throw error;
    }
  }));
  app.post('/api/prospects/import', csvUpload.single('file'), asyncHandler(async (request, response) => {
    const rows = request.file
      ? parse(request.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Array<Record<string, unknown>>
      : Array.isArray(request.body) ? request.body as Array<Record<string, unknown>> : [];
    if (!rows.length) return response.status(400).json({ error: 'Upload a CSV file or send a JSON array' });
    if (rows.length > 500) return response.status(400).json({ error: 'Import is limited to 500 prospects per batch' });
    const inputs = rows.map((row) => prospectInputSchema.parse(normalizeProspectRow(row)));
    const result = await prospectStore.createMany(inputs, config.openaiKey ? 'live' : 'demo');
    response.status(201).json({ created: result.created.length, duplicates: result.duplicates, suppressed: result.suppressed, prospectIds: result.created.map((item) => item.id) });
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
    if (prospect.status === 'unsubscribed' || await prospectStore.isSuppressed(prospect.input.contactEmail)) return response.status(409).json({ error: 'This contact has opted out' });
    response.json(await prospectStore.update(id, { status: 'approved', approvedAt: new Date().toISOString() }, { type: 'status', message: 'Outreach approved by operator' }));
  }));
  app.post('/api/prospects/:id/send', asyncHandler(async (request, response) => {
    if (request.body.confirm !== true) return response.status(400).json({ error: 'Explicit send confirmation is required' });
    const id = param(request, 'id');
    const prospect = await prospectStore.get(id);
    if (!prospect) return response.status(404).json({ error: 'Prospect not found' });
    if (await prospectStore.isSuppressed(prospect.input.contactEmail)) return response.status(409).json({ error: 'This contact is on the do-not-contact list' });
    const result = await sendProspectEmail(prospect);
    if (result.dryRun) {
      await prospectStore.update(id, {}, { type: 'email', message: 'Dry-run passed; configure the email provider to send' });
      return response.json({ status: 'dry-run', previewUrl: `${config.publicUrl}/preview/${prospect.previewToken}` });
    }
    response.json(await prospectStore.update(id, { status: 'sent', sentAt: new Date().toISOString(), providerMessageId: result.messageId }, { type: 'email', message: 'Personalized outreach sent' }));
  }));
  app.post('/api/prospects/:id/status', asyncHandler(async (request, response) => {
    const status = prospectStatusSchema.parse(request.body.status);
    if (!['replied', 'qualified', 'won', 'lost', 'unsubscribed'].includes(status)) return response.status(400).json({ error: 'This status cannot be set manually' });
    const note = String(request.body.note || '').trim();
    const conversionValue = status === 'won' ? Number(request.body.conversionValue || 1500) : undefined;
    response.json(await prospectStore.update(param(request, 'id'), { status, replyNote: note || undefined, conversionValue }, { type: status === 'won' ? 'conversion' : 'status', message: note || `Prospect marked ${status}` }));
  }));

  app.get('/api/suppressions', operatorOnly, asyncHandler(async (_request, response) => response.json(await prospectStore.listSuppressions())));
  app.post('/api/suppressions', operatorOnly, asyncHandler(async (request, response) => {
    const value = String(request.body.value || '');
    response.status(201).json(await prospectStore.suppress(value, `Added to do-not-contact list (${value.trim().toLowerCase()})`));
  }));

  app.use('/api/clients', operatorOnly);
  app.get('/api/clients', asyncHandler(async (_request, response) => response.json(await clientStore.list())));
  app.get('/api/clients/:id', asyncHandler(async (request, response) => {
    const client = await clientStore.get(param(request, 'id'));
    if (!client) return response.status(404).json({ error: 'Client not found' });
    response.json(client);
  }));
  app.put('/api/clients/:id/memory', asyncHandler(async (request, response) => {
    response.json(await clientStore.replaceMemory(param(request, 'id'), clientMemorySchema.parse(request.body)));
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
    const approved = await store.update(param(request, 'id'), { status: 'approved', approvedAt: new Date().toISOString() }, { type: 'approval', message: 'Campaign approved by operator' });
    remember(rememberApproval(clientStore, approved));
    response.json(approved);
  }));
  app.post('/api/projects/:id/revise', asyncHandler(async (request, response) => {
    const note = String(request.body.note || '').trim();
    if (note.length < 3) return response.status(400).json({ error: 'Revision note is required' });
    const id = param(request, 'id');
    const revised = await store.update(id, { status: 'revision', progress: 10, revisionNote: note }, { type: 'note', message: 'Operator submitted a consolidated revision' });
    remember(rememberRevision(clientStore, store, revised, note));
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

function isOperator(request: Request): boolean {
  const suppliedBytes = Buffer.from(request.header('x-adforge-key') || '');
  const expectedBytes = Buffer.from(config.operatorKey);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function operatorOnly(request: Request, response: Response, next: NextFunction): void {
  if (!isOperator(request)) { response.status(401).json({ error: 'Operator authentication required' }); return; }
  next();
}

function remember(task: Promise<void>): void {
  void task.catch((error: unknown) => console.error('Brand memory update failed:', error));
}

function alertOperator(subject: string, lines: string[], idempotencyKey: string): void {
  void notifyOperator(subject, lines, idempotencyKey).catch((error: unknown) => console.error('Operator notification failed:', error));
}

/** Connects an application that came from a Campaign Preview back to its prospect. */
async function linkReferral(project: Project): Promise<Project> {
  const token = project.intake.referral;
  if (!token) return project;
  const prospect = await prospectStore.findByToken(token);
  if (!prospect) return project;
  const status = ['won', 'lost', 'unsubscribed'].includes(prospect.status) ? prospect.status : 'qualified';
  await prospectStore.update(prospect.id, { status, appliedProjectId: project.id }, { type: 'conversion', message: `Applied through the Campaign Preview (project ${project.id.slice(0, 8)})` });
  return store.update(project.id, { prospectId: prospect.id }, { type: 'note', message: `Applied from the Campaign Preview sent to ${prospect.input.companyName}` });
}

/** Ignores views before sending and the first minute after, when mail scanners prefetch links. */
async function recordPreviewView(prospectId: string): Promise<void> {
  const prospect = await prospectStore.get(prospectId);
  if (!prospect?.sentAt || Date.now() - Date.parse(prospect.sentAt) < 60_000) return;
  const views = (prospect.previewViews ?? 0) + 1;
  const first = views === 1;
  await prospectStore.update(prospectId, { previewViews: views, previewFirstViewedAt: prospect.previewFirstViewedAt ?? new Date().toISOString() }, first ? { type: 'note', message: 'Campaign Preview opened for the first time' } : undefined);
  if (first) alertOperator(`Preview opened · ${prospect.input.companyName}`, [`${prospect.input.contactName || 'The contact'} (${prospect.input.contactEmail}) opened their Campaign Preview.`, `Preview: ${config.publicUrl}/preview/${prospect.previewToken}`], `afterword-preview-opened-${prospect.id}`);
}

function normalizeIntake(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, transcript: body.transcript || '', toneNotes: body.toneNotes || '', primaryColor: body.primaryColor || '#E8C97A', expertName: body.expertName || '', voiceExamples: body.voiceExamples || '' };
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
  return `<!doctype html><html><body style="margin:0;background:#f6f2ea;color:#1c1b18;font-family:Arial;display:grid;place-items:center;min-height:100vh;text-align:center"><main><p style="font-family:Georgia,serif;font-size:22px">Afterword<span style="color:#1f4d3a">.</span></p><h1 style="font:400 48px Georgia,serif">${title}</h1><p style="color:#6b665c">${message}</p></main></body></html>`;
}

function unsubscribeConfirmation(token: string, companyName: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f2ea;color:#1c1b18;font-family:Arial;display:grid;place-items:center;min-height:100vh;text-align:center"><main><p style="font:22px Georgia,serif">Afterword<span style="color:#1f4d3a">.</span></p><h1>Stop outreach?</h1><p style="color:#6b665c">Confirm that we should not contact ${escapeHtml(companyName)} at this address.</p><form method="post" action="/api/unsubscribe/${encodeURIComponent(token)}"><button style="border:0;border-radius:3px;background:#1f4d3a;color:#f6f2ea;padding:13px 18px;font-weight:800">Confirm opt-out</button></form></main></body></html>`;
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
