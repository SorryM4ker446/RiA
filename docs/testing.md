# Test coverage and local validation

Use Node.js 24 and the dependencies already installed for this project. No separate server or desktop testing framework is required.

CI selects the current Node.js 24 release, so its minor/patch version can differ from a local installation. Both CI jobs log Node.js/npm versions. When investigating a CI-only failure, compare those versions before concluding that a local pass covers the CI runtime.

| Command | What it checks | External dependencies |
| --- | --- | --- |
| `npm run test:server` | Real route handlers, sessions, ownership, tool logging, memory upserts, chat persistence, media upload/generation/storage, legacy import, path safety and cleanup | Temporary SQLite and media files; deterministic provider doubles; no network or paid model calls |
| `npm run test:e2e` | Production build, chat/tool UI regression, binary attachment uploads, media persistence across reload and storage cleanup confirmation | Existing Playwright Chromium; most UI tests use API doubles, but the media persistence chain uses real HTTP handlers, SQLite and files |
| `npm run test:desktop` | Desktop data paths, media retention when the installation path changes, migrations/backups, packaging privacy boundaries and legacy-video preservation | Node's built-in SQLite and test runner |
| `npm run test:desktop:smoke` | Prepared standalone runtime, renderer/preload, encrypted settings, API/media authentication and conversation/media persistence across a local service restart | Existing Electron runtime; no live AI requests |

Desktop smoke tests resolve an already-installed Electron executable without loading Electron's auto-install entry point. If it is missing, the test fails with an explicit error; it does not download a runtime. The desktop CI job provisions Electron in a separate, explicit step before testing.

`test:server` invokes the actual Next.js request handlers with `NextRequest`; it does not run an HTTP server. It therefore does not replace browser-to-server, reverse-proxy, installer, or live-provider testing. The TypeScript resolver and model override live exclusively under `tests/helpers` and are loaded only by the test command. The application contains no test-provider switch.

The test loader maps `next/server` and `next/headers` to their `.js` entrypoints through `nextResolve`. Do not call `require.resolve()` inside the synchronous resolve hook: it re-enters that hook on newer Node.js versions and can overflow the call stack. Loader regression tests check both ESM and CommonJS entrypoints with a re-entry guard and run automatically with `test:server`.

SQLite concurrency tests use the same application client as Web and Electron, not a test-only connection override. The client enforces `connection_limit=1`, `pool_timeout=30`, and `socket_timeout=5` while preserving the database path and other datasource parameters. Interactive transactions also wait up to 30 seconds to acquire a connection; their execution timeout is not extended. This bounds waiting without retrying failed writes or hiding database errors.

One regression holds an application write transaction for 6.5 seconds (longer than SQLite's 5-second lock timeout), then verifies eight concurrent memory upserts and another transaction all finish, leave one memory row, and allow subsequent writes. Another holds a lock from an independent SQLite connection, expects `P1008`, and verifies recovery after releasing it. The Prisma error printed by that negative test is expected; the test must pass. Concurrent-write tests await all settled results before propagating any rejection, so failed operations cannot spill into later tests or database cleanup. These regressions run automatically through the existing CI `test:server` step; no extra package or workflow is needed.

Multipart fixtures are serialized to wire bytes before reaching the handler. This avoids racing Node's client-side FormData encoder when the server rejects and cancels an oversized request. A separate streaming test verifies that requests without `Content-Length` still hit the byte limit and cancel their source; the production limit is not bypassed or disabled.

Server tests create and clean their own temporary databases. Browser tests use `.desktop-data/test/playwright-<pid>/app.db`. Neither suite uses the development database. The standalone `test:db` command uses the configured local database, so set `LOCAL_DATABASE_FILE` to an isolated path when running it as a regression check.

Media tests cover authenticated file reads, range/HEAD responses, signature/type/size restrictions, remote-reference rejection, shared references, fresh cleanup grace periods after deletion, legacy import, path traversal, and Windows junction rejection. The small video provider fixture tests transport/storage, not actual video decoding. One browser chain uploads and stores a real PNG through HTTP, reloads it from SQLite-backed history, and verifies reference-safe deletion without mocking business APIs.

Another browser test exercises the image-generation UI's new asset response contract and persists/reloads the result using real message and media APIs; only the paid generation response is mocked. Storage statistics and cleanup ownership are tested against actual route handlers and SQLite. Build preparation and verification reject fixtures containing user data; the legacy-video guard is checked before any output replacement.

Run lint, TypeScript, server tests, browser tests and a production build before accepting related changes. When the database schema changes, regenerate Prisma first with `npm run db:generate`, then run the desktop migration tests as well. Do not run `next dev` and `next build` simultaneously against the same `.next` directory.

Browser tests build, prepare `.desktop-runtime`, and start the standalone production server automatically. This avoids development hot reloads resetting a page during parallel tests and follows the project's standalone output configuration. The test environment blanks the model-provider key and uses a placeholder search key, never live provider credentials. Do not run browser tests alongside desktop builds or smoke tests that use the same generated runtime.

`desktop:build` verifies only the runtime it just prepared, not a possibly stale installer/package from an earlier build. Run `desktop:verify` after packaging to check the packaged application too. Local database verification also checks asset/reference persistence and user-deletion cascades; it does not write media files.

## Conversation behavior covered by regression tests

- Recent assistant answers remain available to follow-up questions.
- Refreshing restores the last selected conversation even when a newer conversation exists.
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

These tests do not certify every real OpenRouter model, network outage behavior, or clean-machine installation/uninstallation. Desktop path isolation and restart persistence are tested, but a full installer upgrade/uninstall cycle remains a separate check. Distinguish the real media HTTP/SQLite chain from the mocked UI tests when reporting coverage.
