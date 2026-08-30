# Private AI Assistant

Private AI Assistant is a local-first AI assistant built with Next.js, Vercel AI SDK, Electron, Prisma, and SQLite. It can run in a browser during development or as an installable Windows desktop application.

## Capabilities

- Streaming, persisted multi-turn chat through OpenRouter
- Local conversations, messages, memories, knowledge, and tasks
- Semantic knowledge retrieval with keyword fallback
- Tavily web search and tool-call approval flows
- Image and video generation modes
- Windows desktop shell with encrypted API-key storage

## Requirements

- Node.js 24.9.0 for development and packaging, matching CI
- Windows x64 for producing the Squirrel installer
- An OpenRouter API key for AI generation
- A Tavily API key only when web search is needed

The installed desktop application does not require Node.js or PostgreSQL.

## Browser development

```powershell
npm install
npm run db:generate
npm run dev
```

The local SQLite database defaults to `.desktop-data/dev/app.db`. Browser development uses a single local demo user unless `AUTH_DISABLED` is overridden.

API requests enforce input/size limits, consistent errors, local quotas and same-origin browser writes. Non-loopback hosts require an explicit `APP_ORIGIN`; see [API contracts and local security](docs/api-security.md) before changing local access or proxy settings.

## Desktop development

```powershell
npm run desktop:dev
```

Electron starts and stops the local Next.js development service automatically. Use the desktop Settings page to store API keys with Windows encryption.

## Build and package

```powershell
npm run desktop:build
npm run desktop:package
npm run desktop:make
```

- `desktop:build` creates and verifies `.desktop-runtime`.
- `desktop:package` creates the unpacked Windows application under `out/`.
- `desktop:make` creates the Windows Setup executable and Squirrel metadata under `out/make/`.

## Validation

```powershell
npm run lint
npm run typecheck
npm run test:server
npm run test:db
npm run test:e2e
npm run test:desktop
npm run test:desktop:smoke
npm run desktop:verify
npm run test:desktop:package
```

Desktop validation uses Node's built-in test runner and a hidden Electron window; it does not require an additional desktop test framework.

Server regression tests use real route handlers and temporary SQLite databases, with only the external AI provider replaced by a deterministic test double. See [Test coverage and local validation](docs/testing.md) for the boundary between UI tests, server tests, and live-provider validation.

See [Desktop development and release](docs/desktop.md) for data paths, security behavior, troubleshooting, and release checks.

Images, videos, and attachments use private file-backed media assets instead of inline message data. Open **存储管理** from the chat header to inspect disk usage and clean expired unreferenced files. See [Media storage and migration](docs/media-storage.md) for limits, API changes, legacy-data handling, and backup requirements.

## Project layout

- `electron`: desktop main process, preload bridge, migrations, settings, and security
- `src/app`: pages and route handlers
- `src/features`: chat-facing business capabilities
- `src/db`: Prisma schema and SQLite migrations
- `src/tools`: tool definitions and registry
- `scripts`: local database, desktop build, packaging, and verification helpers
- `tests`: browser and desktop regression tests
