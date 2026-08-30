# Test coverage and local validation

Use Node.js 24.9.0 and the dependencies already installed for this project. No separate server or desktop testing framework is required.

Both CI jobs pin Node.js to 24.9.0 to match the local development runtime and log Node.js/npm versions. When upgrading the local Node.js runtime, update both `actions/setup-node` steps in `.github/workflows/ci.yml` and revalidate with that version. A local pass still does not replace a GitHub Actions run.

| Command | What it checks | External dependencies |
| --- | --- | --- |
| `npm run test:server` | Real route handlers, sessions, ownership, tool logging, memory upserts, chat persistence, media upload/generation/storage, legacy import, path safety and cleanup | Temporary SQLite and media files; deterministic provider doubles; no network or paid model calls |
| `npm run test:e2e` | Production build, chat/tool UI regression, binary attachment uploads, media persistence across reload and storage cleanup confirmation | Existing Playwright Chromium; most UI tests use API doubles, but the media persistence chain uses real HTTP handlers, SQLite and files |
| `npm run test:desktop` | Desktop development window visibility, bounded/redacted logs, data paths, media retention when the installation path changes, migrations/backups, packaging privacy boundaries and legacy-video preservation | Node's built-in SQLite/test runner and existing Electron on Windows |
| `npm run test:desktop:smoke` | Prepared standalone runtime, renderer/preload, encrypted settings, API/media authentication and conversation/media persistence across a local service restart | Existing Electron runtime; no live AI requests |

Desktop smoke tests resolve an already-installed Electron executable without loading Electron's auto-install entry point. If it is missing, the test fails with an explicit error; it does not download a runtime. The desktop CI job provisions Electron in a separate, explicit step before testing.

On Windows, the development-launcher regression runs the actual launch script against a minimal local Electron page with an isolated temporary userData directory. It briefly shows a small test window and asserts visibility after `show()`; hidden smoke tests cannot detect this startup regression. It does not start Next.js, touch development data or call a model provider. Other platforms skip this Windows-specific check.

Security regressions cover all protected route entrypoints, malformed and oversized bodies, nested chat/media schemas, tool configuration ordering, quotas/recovery/user isolation, expired-session pruning, Host/Origin/Fetch Metadata rejection, sanitized database errors and streamed persistence conflicts. Negative database tests deliberately trigger unique-constraint and missing-table errors in their isolated database; sanitized responses must hide query details. Login/register, manual/automatic tools and media quotas run through actual handlers, without external model calls.

The authentication browser test starts an additional server from the already-built standalone runtime after the main test server is ready. It uses its own dynamically selected loopback port and `.desktop-data/test/auth-*` SQLite/media directory with AUTH_DISABLED=0 and blank provider keys. It exercises real registration/login/logout, cookie attributes, expired-session rejection, CSRF and login throttling, then stops that server and removes only its own directory. Other browser tests verify readable HTTP 429 and streamed conflict messages. The Electron smoke also checks foreign Origin/Host rejection, standardized errors and chat throttling without invoking a provider.

These cases are discovered by the existing CI `test:server`, `test:e2e` and desktop smoke commands; no additional CI job, dependency, browser download or deployment infrastructure is required for local validation. A local pass is not a GitHub Actions result.

Chat module regressions also exercise the browser API client's error parsing and attachment/reference contracts, automatic tool-intent gating with a deterministic model, preference normalization, manual tool fields, and shared memory ranking against isolated SQLite. Context recall retains its recency/manual weights and tool memories; explicit knowledge search retains smaller candidate limits, excludes tool memories, and merges built-in knowledge. Both now use normalized Chinese segmentation and bounded recent/lexical candidate sets. Tests verify older Chinese matches remain retrievable behind more than 100 unrelated newer records, scoring runs once per candidate, and ties remain stable without requiring a particular ICU dictionary split.

Browser lifecycle regressions cover switching conversations while old history succeeds or fails late, restoring per-conversation controls, creating/renaming/deleting conversations with confirmation, and video asset-reference persistence across reload. The video UI fixture does not validate video decoding or a live provider. The existing real image upload/persistence chain and Electron smoke remain responsible for actual private asset storage and desktop compatibility.

Pagination regressions use real SQLite with more than two pages, equal timestamps, cursor-anchor deletion, invalid limits and cross-user cursors. They verify newest-first conversation traversal, chronological message pages, count-only detail reads and regeneration snapshots limited to the affected tail. Browser fixtures cover explicit page loading, duplicate boundaries, saved selection outside the first page, and late older-page responses after switching conversations. Those fixtures test UI behavior; route tests cover database pagination. See [Local API contracts](local-api.md).

Model catalog checks run inside `test:server` with synthetic provider snapshots; they validate structure, explicit defaults and removal/capability warnings without checking live availability. `npm run models:check` is also available for maintainers. Desktop logger tests cover byte/file bounds, legacy oversized logs, credentials split across chunks, Unicode decoding and excessive lines. The real Electron smoke confirms Next output uses the bounded/redacted writer after service restart.

`npm run test:desktop:dev` exercises the same smoke assertions against Next development mode. Both development and standalone smoke runs isolate Electron userData as well as SQLite/media, override inherited desktop path/runtime choices, and use the invoking Node executable for development. Run them sequentially after browser tests/builds; neither needs an installer or paid model.

The chat page composes views from `src/features/chat`; hooks own browser state while `api-client.ts` owns HTTP serialization and API errors. The chat route composes `src/lib/chat` request, context, intent, streaming and persistence modules. Browser modules must not import database/provider implementations. Extracted domain modules use the existing `@/` imports, which are understood by both Next.js and the test loader; no loader workaround or new test runner is needed.

`test:server` invokes the actual Next.js request handlers with `NextRequest`; it does not run an HTTP server. It therefore does not replace browser-to-server, reverse-proxy, installer, or live-provider testing. The TypeScript resolver and model override live exclusively under `tests/helpers` and are loaded only by the test command. The application contains no test-provider switch.

The test loader maps `next/server` and `next/headers` to their `.js` entrypoints through `nextResolve`. Do not call `require.resolve()` inside the synchronous resolve hook: it re-enters that hook on newer Node.js versions and can overflow the call stack. Loader regression tests check both ESM and CommonJS entrypoints with a re-entry guard and run automatically with `test:server`.

SQLite concurrency tests use the same application client as Web and Electron, not a test-only connection override. The client enforces `connection_limit=1`, `pool_timeout=30`, and `socket_timeout=5` while preserving the database path and other datasource parameters. Interactive transactions also wait up to 30 seconds to acquire a connection; their execution timeout is not extended. This bounds waiting without retrying failed writes or hiding database errors.

One regression holds an application write transaction for 6.5 seconds (longer than SQLite's 5-second lock timeout), then verifies eight concurrent memory upserts and another transaction all finish, leave one memory row, and allow subsequent writes. Another holds a lock from an independent SQLite connection, expects `P1008`, and verifies recovery after releasing it. That negative test expects a bounded database error and verifies recovery; raw Prisma diagnostics are suppressed to avoid logging query values. Concurrent-write tests await all settled results before propagating any rejection, so failed operations cannot spill into later tests or database cleanup. These regressions run automatically through the existing CI `test:server` step; no extra package or workflow is needed.

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
