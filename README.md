# AdForge Production Engine

AdForge turns one expert recording into a reviewed monthly B2B content bundle: a premium guide, eight LinkedIn posts, three emails, and landing-page copy. It is designed as the operator system behind a productized service, not as a self-serve writing toy.

It also includes the acquisition layer: import source-qualified prospects, score the fit, generate a private Campaign Preview and meeting-free outreach, approve the exact message, and track the prospect through reply, qualification, and $1,500 MRR conversion.

## What is included

- Public multipart intake endpoint for a transcript, a source file, or just a public source URL
- Automatic source capture: direct recordings are downloaded and transcribed, readable pages become a transcript candidate, anything else waits for the operator
- Transactional email through Resend: application confirmations, operator alerts, review-link delivery, client decisions, and failures
- Safe brand-signal extraction with DNS and browser-request SSRF protection
- Speaker-aware transcription and structured campaign generation when OpenAI is configured
- Fully functional demo mode when no API key is present
- Deterministic editorial QA gates before anything reaches a client
- Branded A4 PDF, HTML landing page, Markdown assets, source map, and ZIP delivery
- Tokenized client review page with one-click approval or one consolidated revision
- Password-style operator API and a responsive production dashboard
- Atomic local persistence, queue concurrency control, rate limiting, upload limits, and a non-root Docker runtime
- CSV/JSON prospect import with duplicate protection and batches of up to 500 records
- Evidence-based qualification, public-source Campaign Previews, and concise outreach drafts
- Mandatory operator approval, duplicate-send protection, one-click opt-out, and dry-run email mode

## Local setup

```bash
npm install
npm run setup:browsers
cp .env.example .env
npm run dev
```

Open `http://localhost:3001`. The default local operator key is `local-adforge-demo`. Click **Create demo project** to exercise the entire pipeline without external credentials.

The dashboard opens on **Prospect engine**. Click **Create demo prospect** to exercise qualification and preview generation. Import `examples/prospects.csv` to see the required bulk format.

For live projects, set `OPENAI_API_KEY`. The content and transcription model names are configurable through the environment. Uploaded source material may be audio, video, PDF, or presentation media; live transcription currently applies to audio/video files. A pasted transcript is the most deterministic input.

## API flow

1. `POST /api/intake` accepts the customer brief with an optional `transcript` or `sourceFile`. The client receives a confirmation email and the operator an alert.
2. With a transcript or recording on file the in-process queue transcribes, extracts brand signals, writes, checks, and renders immediately.
3. With only a `sourceUrl` the project waits in `awaiting-source`. The engine downloads direct audio/video files automatically, stores readable page text as a candidate transcript, and otherwise leaves the source to the operator.
4. `POST /api/projects/:id/source` (operator, multipart `transcript` or `sourceFile`) completes intake and queues production. The dashboard shows this form, prefilled with any captured candidate.
5. When the quality gate passes the operator is emailed. `POST /api/projects/:id/deliver` (or the dashboard's **Send to client**) emails the private review link. Set `ADFORGE_AUTO_DELIVER=true` to skip the operator check.
6. `GET /review/:token` gives the client a private review page. Approval locks the delivery and emails the operator; a revision re-enters the same controlled pipeline and comes back through step 5.
7. Operators download the finished ZIP from the dashboard or authenticated API.

Authenticated operator routes require `x-adforge-key: <ADFORGE_OPERATOR_KEY>`.

## Email

All email goes through one verified Resend sender (`ADFORGE_OUTREACH_FROM`). Operator notifications go to `ADFORGE_OPERATOR_EMAIL`. Without `RESEND_API_KEY` every send is recorded on the project timeline as a dry run, so the complete flow can be exercised locally. `GET /health` reports whether outreach, notifications, and delivery are live.

## Prospect flow

1. Import a CSV through the dashboard or `POST /api/prospects/import`.
2. Generate up to 50 queued previews at a time through `POST /api/prospects/batch/generate`.
3. Review the fit score, reasons, private preview, subject, and exact email in the dashboard.
4. Approve one prospect explicitly with `POST /api/prospects/:id/approve`.
5. Send with `{ "confirm": true }` to `POST /api/prospects/:id/send`.
6. Track replies and conversions through `POST /api/prospects/:id/status`.

Without `RESEND_API_KEY` and `ADFORGE_OUTREACH_FROM`, step five performs a safe dry run. When configured, it sends through Resend with an idempotency key and unsubscribe headers. The engine never discovers or guesses personal email addresses; import only business contacts you are permitted to approach, respect regional marketing rules, and honor suppression immediately.

Required CSV fields are `companyName`, `website`, `sourceUrl`, `sourceTitle`, and `sourceSummary`. The summary should contain enough genuine source detail to support useful personalization. `contactName`, `contactEmail`, `role`, `country`, `offerHint`, and `notes` are optional at import time, although a verified email is required before sending.

## Production deployment

Everything persistent (`data/`, `uploads/`, `artifacts/`) lives under `ADFORGE_STORAGE_DIR`, which the container sets to `/app/storage`. Mount one volume there.

### Fly.io (recommended)

`fly.toml` is included. The queue runs in-process, so the machine is configured to never auto-stop, and the Playwright renderer needs the 2 GB memory setting.

```bash
fly launch --copy-config --no-deploy
fly volumes create adforge_storage --size 10 --region arn
fly secrets set \
  ADFORGE_OPERATOR_KEY='replace-with-a-long-secret' \
  OPENAI_API_KEY='...' \
  RESEND_API_KEY='...' \
  ADFORGE_OUTREACH_FROM='AdForge <hello@adforgecreative.com>' \
  ADFORGE_OUTREACH_REPLY_TO='hello@adforgecreative.com' \
  ADFORGE_OPERATOR_EMAIL='hello@adforgecreative.com'
fly deploy
```

Then set `ADFORGE_PUBLIC_URL` in `fly.toml` to the app's final hostname (a custom domain such as `https://engine.adforgecreative.com` after `fly certs add`), and point the marketing site's `NEXT_PUBLIC_ADFORGE_API_URL` at it so the application form posts straight into the engine.

### Any Docker host

```bash
docker build -t adforge-production-engine .
docker run --rm -p 3001:3001 \
  -e ADFORGE_OPERATOR_KEY='replace-with-a-long-secret' \
  -e ADFORGE_PUBLIC_URL='https://engine.example.com' \
  -e ADFORGE_ALLOWED_ORIGINS='https://www.example.com' \
  -e ADFORGE_OPERATOR_EMAIL='you@example.com' \
  -e OPENAI_API_KEY='...' \
  -e RESEND_API_KEY='...' \
  -e ADFORGE_OUTREACH_FROM='AdForge <hello@your-domain.com>' \
  -v adforge-storage:/app/storage \
  adforge-production-engine
```

This storage design is intentionally optimized for the first 5-10 retained clients on one worker. Before horizontal scaling, move the store and queue to Postgres/Redis and artifacts to object storage. The current API and project model provide a clean migration boundary.

## Quality and security

```bash
npm run check
```

The renderer validates fixed-page overflow before creating a PDF. Remote brand extraction blocks loopback, private, link-local, credentialed, and non-HTTP URLs, and validates subresources independently. In production the application refuses to start with the local demo operator key.

The original proof-of-concept server and fixed templates are preserved under `legacy/`; they are not part of the production build.

Do not expose the operator dashboard publicly without TLS and a strong key. Configure CORS to the exact marketing-site origin and back up the three persistent data directories.
