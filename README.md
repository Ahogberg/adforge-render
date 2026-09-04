# AdForge Production Engine

AdForge turns one expert recording into a reviewed monthly B2B content bundle: a premium guide, eight LinkedIn posts, three emails, and landing-page copy. It is designed as the operator system behind a productized service, not as a self-serve writing toy.

## What is included

- Public multipart intake endpoint for a transcript or source file
- Safe brand-signal extraction with DNS and browser-request SSRF protection
- Speaker-aware transcription and structured campaign generation when OpenAI is configured
- Fully functional demo mode when no API key is present
- Deterministic editorial QA gates before anything reaches a client
- Branded A4 PDF, HTML landing page, Markdown assets, source map, and ZIP delivery
- Tokenized client review page with one-click approval or one consolidated revision
- Password-style operator API and a responsive production dashboard
- Atomic local persistence, queue concurrency control, rate limiting, upload limits, and a non-root Docker runtime

## Local setup

```bash
npm install
npm run setup:browsers
cp .env.example .env
npm run dev
```

Open `http://localhost:3001`. The default local operator key is `local-adforge-demo`. Click **Create demo project** to exercise the entire pipeline without external credentials.

For live projects, set `OPENAI_API_KEY`. The content and transcription model names are configurable through the environment. Uploaded source material may be audio, video, PDF, or presentation media; live transcription currently applies to audio/video files. A pasted transcript is the most deterministic input.

## API flow

1. `POST /api/intake` accepts the customer brief and optional `sourceFile`.
2. The in-process queue transcribes, extracts brand signals, writes, checks, and renders.
3. `GET /review/:token` gives the client a private review page.
4. Approval locks the delivery; a revision re-enters the same controlled pipeline.
5. Operators download the finished ZIP from the dashboard or authenticated API.

Authenticated operator routes require `x-adforge-key: <ADFORGE_OPERATOR_KEY>`.

## Production deployment

Build and run the container with a persistent volume mounted over `/app/data`, `/app/uploads`, and `/app/artifacts`:

```bash
docker build -t adforge-production-engine .
docker run --rm -p 3001:3001 \
  -e ADFORGE_OPERATOR_KEY='replace-with-a-long-secret' \
  -e ADFORGE_PUBLIC_URL='https://production.example.com' \
  -e ADFORGE_ALLOWED_ORIGINS='https://www.example.com' \
  -e OPENAI_API_KEY='...' \
  -v adforge-data:/app/data \
  -v adforge-uploads:/app/uploads \
  -v adforge-artifacts:/app/artifacts \
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
