# Test coverage and local validation

Use Node.js 24 and the dependencies already installed for this project. No separate server or desktop testing framework is required.

| Command | What it checks | External dependencies |
| --- | --- | --- |
| `npm run test:server` | Real route handlers, sessions, ownership, tool logging, memory upserts, streamed-response persistence, regeneration and approval replay protection; context and message-codec regressions | Temporary SQLite files; deterministic AI SDK model doubles; no network or paid model calls |
| `npm run test:e2e` | Production build, then browser interaction for manual tools, knowledge entries, task status, reloaded approvals and editing/regeneration | Existing Playwright Chromium; business APIs are mocked |
| `npm run test:desktop` | Desktop data paths, database initialization, idempotent migrations, duplicate-memory preservation and upgrade backups | Node's built-in SQLite and test runner |
| `npm run test:desktop:smoke` | Prepared standalone runtime, renderer/preload, encrypted settings, desktop API authentication and conversation persistence across a local service restart | Existing Electron runtime; no live AI requests |

Desktop smoke tests resolve an already-installed Electron executable without loading Electron's auto-install entry point. If it is missing, the test fails with an explicit error; it does not download a runtime. The desktop CI job provisions Electron in a separate, explicit step before testing.

`test:server` invokes the actual Next.js request handlers with `NextRequest`; it does not run an HTTP server. It therefore does not replace browser-to-server, reverse-proxy, installer, or live-provider testing. The TypeScript resolver and model override live exclusively under `tests/helpers` and are loaded only by the test command. The application contains no test-provider switch.

Server tests create and clean their own temporary databases. Browser tests use `.desktop-data/test/playwright-<pid>/app.db`. Neither suite uses the development database. The standalone `test:db` command uses the configured local database, so set `LOCAL_DATABASE_FILE` to an isolated path when running it as a regression check.

Run lint, TypeScript, server tests, browser tests and a production build before accepting related changes. When the database schema changes, regenerate Prisma first with `npm run db:generate`, then run the desktop migration tests as well. Do not run `next dev` and `next build` simultaneously against the same `.next` directory.

Browser tests build, prepare `.desktop-runtime`, and start the standalone production server automatically. This avoids development hot reloads resetting a page during parallel tests and follows the project's standalone output configuration. The test environment blanks the model-provider key and uses a placeholder search key, never live provider credentials. Do not run browser tests alongside desktop builds or smoke tests that use the same generated runtime.

## Conversation behavior covered by regression tests

- Recent assistant answers remain available to follow-up questions.
- Older tool results are historical context, not fresh tool calls or approvals.
- Long conversations retain the active turn and bounded, explicitly incomplete excerpts. These excerpts are not model-generated summaries and do not guarantee recall of every older detail.
- Approval metadata survives history loading. Approval decisions are matched to persisted pending calls and atomically claimed before executing a tool; replayed or modified decisions are rejected.
- Completed approval continuations update their existing assistant message rather than inserting duplicates.
- Approval processing favors at-most-once execution. An interrupted continuation is not automatically replayed; reload the conversation and check the task state before requesting a new action.
- Regeneration retains old replies until a successful stream finishes. Failed streams and concurrent edits do not erase the original history.
- Editing a user message persists the edit and starts regeneration. A failed generation can leave the previous answer in storage until a later successful retry.

## Memory migration

The unique `(userId, key)` migration keeps the most recently updated duplicate under the original key. Older entries are retained with a ` [duplicate:<id>]` suffix; collisions receive additional underscores. No memory values are deleted. Desktop startup creates a backup before applying an unapplied migration to an existing application database.

The local Prisma migration wrapper does not itself create backups. Back up an existing database before using `db:deploy` outside the desktop startup workflow. Automated tests apply migrations only to isolated databases.

## Remaining validation boundaries

These tests do not certify every real OpenRouter model, network outage behavior, clean-machine installation/uninstallation, or media survival across application upgrades. Those remain separate checks; a passing mocked browser suite must not be described as a complete API-to-database end-to-end test.
