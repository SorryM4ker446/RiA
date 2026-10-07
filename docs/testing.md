# Test coverage and local validation

Use Node.js 24.9.0 and the dependencies already installed for this project. No separate server or desktop testing framework is required.

The application ships as a Windows desktop program; there is no browser or web deployment target. "Browser tests" below means a Chromium renderer driving the application's own HTTP surface — the same renderer the desktop shell embeds — and is a description of the harness, not a supported form of the product.

Both CI jobs pin Node.js to 24.9.0 to match the local development runtime and log Node.js/npm versions. When upgrading the local Node.js runtime, update both `actions/setup-node` steps in `.github/workflows/ci.yml` and revalidate with that version. A local pass still does not replace a GitHub Actions run.

Chat approval browser tests require pending tool details to be open immediately, then verify that approval or denial sends exactly one continuation. Tool output can render before the end-of-stream database write; the persistence test waits for the completed tool state in the history API before reloading, then requires the restored result and exactly one task. Title-row geometry tests cover the current 44px row, content and conversation rail below it, rail collapse/expansion, and navigation to the independent tasks page.

Knowledge-scope coverage holds the initial conversation-list response while document collections render, requires scope controls to stay disabled until the target conversation loads, and holds a scope PATCH while asserting that scope changes and message sending are disabled. It also rejects a save, verifies unchanged selection and recovery on retry, then checks collection isolation and persisted citations after reload. Collection loading must run once per toolbar mount rather than retriggering on every render. These request gates replace timing assumptions. WiX provisioning tests run the real PowerShell script with `Get-FileHash` unavailable and require both successful verified extraction and rejection of corrupt ZIP bytes; cold-download acceptance uses an empty isolated tooling directory.

Scheduled-execution and reminder restart fixtures write only after the isolated server has stopped and before it starts again, avoiding races with the live scheduler's SQLite transactions.

The trusted caption-click check uses its own `.desktop-data/test/caption-click-*` profile and database, runs the prepared standalone server, and waits for both a native maximize/restore transition and its matching renderer label. Failure prints the bounded application log; CI uploads only the redacted logs from these profiles. Packaged-runtime verification and packaged smoke run in separate CI steps so either failure independently fails the job.

| Command | What it checks | External dependencies |
| --- | --- | --- |
| `npm run test:server` | Real route handlers, CRUD, the local credential boundary, tool logging/timeouts, chat persistence/abort, media storage, legacy import, path safety and cleanup | Temporary SQLite/media; deterministic model doubles and a loopback search server; no paid model calls |
| `npm run test:e2e` | Production build, chat/tool UI regression, credential-gated chat/task/knowledge persistence, binary uploads and storage cleanup | Existing Playwright Chromium; API doubles for UI cases, real HTTP/SQLite for integration cases, offline responses at the model boundary |
| `npm run test:desktop` | Desktop development window visibility, bounded/redacted logs, data paths, media retention when the installation path changes, migrations/backups, packaging privacy boundaries and legacy-video preservation | Node's built-in SQLite/test runner and existing Electron on Windows |
| `npm run test:desktop:smoke` | Prepared standalone runtime, renderer/preload, encrypted settings, API/media authentication and conversation/media persistence across a local service restart | Existing Electron runtime; no live AI requests |

Desktop smoke tests resolve an already-installed Electron executable without loading Electron's auto-install entry point. If it is missing, the test fails with an explicit error; it does not download a runtime. The desktop CI job provisions Electron in a separate, explicit step before testing.

Conversation regressions exercise literal full-history search, Chinese short queries, pin/tag/archive pagination, stale archived selections, confirmed atomic bulk deletion, the credential boundary/expiry/quotas, and text export privacy/limits. Browser tests download Markdown and JSON through the real authenticated API. Migration tests backfill legacy content, verify backups and index consistency after VACUUM/restart, and check cascades. Electron smoke downloads both formats from the actual management UI after restarting the local service, saves them in its isolated test directory and verifies text/media references. Existing CI test globs and runtime preparation include these checks and SQL migrations; no new service, secret or dependency is required.

Media library regressions cover filtered pagination, source/recipe persistence, original-parameter regeneration, reference-image deletion/cleanup protection, renewed cleanup grace periods, missing inputs, provider failures, concurrent source/input deletion, confirmation, the credential boundary, quotas and a missing credential. Browser tests exercise actual production HTTP, SQLite, image/video generation and download handlers, with only upstream responses simulated. They inspect decoded PNGs, recorded video parameters and downloaded bytes; the minimal video fixture tests transport and the unsupported-preview fallback, not successful video decoding. They do not use real API keys or incur generation charges.

Media migration tests preserve existing files' metadata/message references, check the pre-migration backup, and verify source-pointer and generation-reference cascades after reopening SQLite. Electron smoke seeds synthetic recipe/dependency metadata in its isolated database, restarts the service, opens the actual library UI, downloads a private PNG to its isolated directory, then deletes the unused output without damaging its input. It rejects unconfirmed regeneration without invoking a provider. The existing CI test globs and migration copying include this coverage; no workflow or configuration change is required.

Workspace backup regressions cover portable media/document references, repeated import, bounded ordered chunks, checksums and invalid relationships, transaction rollback, safety copies, retention, pending approval/reminder suppression and maintenance exclusion through HTTP disconnect and persistence. Browser cases download actual archives, import more than one chunk, restore and restart an isolated service, and check refusal without the credential. The model cases verify saved defaults, opt-in fallback through the actual provider adapter, no fallback after output/tools/cancellation, latency/tokens, provider/configured/unknown/zero costs and isolated retention. Upstream failures and responses are synthetic; no real API keys or paid calls are used.

The saved-defaults browser regression holds the real conversation-creation POST until the image composer is visible while the database list is still empty. It then releases that request, requires HTTP 201, and checks the returned conversation ID, rendered row and persisted preferences. The composer placeholder alone does not prove creation has finished; the test uses request completion and retrying state assertions without fixed sleeps or whole-test retries.

Electron regression tests upgrade an old schema, verify its pre-migration backup, reopen stored preferences/usage and test cascades. Both desktop smoke modes now use the real backup/model pages and API, download an archive to isolated storage, confirm restore and restart again before checking media/defaults and disabled reminders. Existing CI commands/globs pick up these tests and migrations; no new workflow, dependency or secret is needed. Maximum-size archives, physical disk-full/power-loss behavior, live provider availability/billing and installer upgrade/uninstall/reinstall still require separate acceptance.

Task reminder regressions include timezone/DST and month-end calculation, atomic recurrence and concurrent claims, old-database migration, manual-tool timezone conversion, overdue display, settings validation, the credential boundary, quotas and service restart. Electron smoke seeds only its isolated database, uses the real task API and main-process poller, and records notification dispatch without native toasts. Adapter tests check native options/click/failure behavior; actual installed Windows notification display and physical sleep/resume remain manual checks. See [Task reminders](task-reminders.md). Existing server/browser/desktop CI commands discover these tests without another service, package or job.

On Windows, the development-launcher regression runs the actual launch script against a minimal local Electron page with an isolated temporary userData directory. It briefly shows a small test window and asserts visibility after `show()`; hidden smoke tests cannot detect this startup regression. It does not start Next.js, touch development data or call a model provider. Other platforms skip this Windows-specific check.

`local-entry.test.ts` exchanges a fresh handshake through the actual entry handler for IPv4 loopback, localhost and IPv6 loopback origins. It checks that the relative redirect retains the browser's original host and port, that the issued cookie remains HttpOnly and host-only, and that the cookie passes the next protected API request's security check. This catches NextURL loopback normalization without relying on a pre-injected test cookie.

Security regressions cover all protected route entrypoints, malformed and oversized bodies, nested chat/media schemas, tool configuration ordering, instance-level quotas/recovery, Host/Origin/Fetch Metadata rejection, sanitized database errors and streamed persistence conflicts. Negative database tests deliberately trigger unique-constraint and missing-table errors in their isolated database; sanitized responses must hide query details. Manual/automatic tools and media quotas run through actual handlers, without external model calls.

The access browser test starts an additional server from the already-built standalone runtime after the main test server is ready. It uses its own dynamically selected loopback port and `.desktop-data/test/http-*` SQLite/media directory with blank provider keys. It exercises the credential boundary: the entry point refuses a caller without the current code, the issued cookie is HttpOnly and SameSite=Lax, a forged or absent credential is refused and a foreign Origin is rejected; the spec then stops that server and removes only its own directory. Other browser tests verify readable HTTP 429 and streamed conflict messages. The Electron smoke also checks foreign Origin/Host rejection, standardized errors and chat throttling without invoking a provider.

`business-persistence.spec.ts` also uses isolated standalone servers, with no browser route interception and no database mocks. One flow opens the workspace, sends a first message from an empty conversation, streams a reply, sends a follow-up, edits/regenerates, restarts the service, and checks history. Another creates and updates tasks, upserts and retrieves knowledge, renames the conversation, restarts and deletes the records. Assertions inspect both HTTP results and persisted SQLite rows. Synthetic embedding/completion responses are the only provider replacements; this is not a model-quality test.

`knowledge-pagination.test.ts` traverses 127 equal-timestamp memories without omissions or duplicates, checks deleted cursor anchors and newer inserts, literal title/content searches (including `%` and `_`), confirmation filters, query validation/authentication and cursor scope. List responses retain the existing lightweight `data` array and add `pageInfo: { nextCursor, hasMore }`; the default limit remains 50, with a maximum of 100. `q` is trimmed, limited to 120 characters, and searched locally; `view` accepts `all`, `confirmed` or `candidates`. Unknown/repeated parameters are rejected. The existing database indexes support the stable `updatedAt DESC, id DESC` order; no migration is needed.

`knowledge-management.spec.ts` seeds only its isolated SQLite database while the standalone service is stopped. Browser tests reach memories past the first 100, navigate backwards, search and filter, accept/edit/delete through real APIs, and inspect persisted rows. Separate HTTP failure doubles check retained edit drafts/deletion rows, failed search scope, and a successful write followed by a failed list refresh (obsolete pagination is disabled until first-page recovery succeeds); an explicitly held response checks superseded search cancellation without timing sleeps. Desktop/mobile screenshots are saved to the system temporary directory, with their paths attached to the test result. Existing silent-refresh tests continue to require that refresh preserves visible rows.

The test-only `offline-http.ts` preload intercepts fetch in those child processes using the existing Undici dependency. It uses matching fetch/dispatcher versions, bridges native Request/Response, denies unmatched destinations and endpoints, and emits synthetic model prompts over IPC for context assertions. It does not store request headers or add a test switch to application code. A server regression checks both provider-disabled and simulated-provider modes and rejects unmatched external and loopback fetches. This guard covers fetch, not every possible socket API; Tavily is disabled in these browser fixtures. The separate search adapter tests point Tavily explicitly at an isolated loopback server.

Run `npm run test:e2e -- --grep '@integration'` to select authenticated HTTP/SQLite flows, or add `--repeat-each=3` to check repeatability. Quote the tag in PowerShell to avoid splatting. This still builds and prepares the production runtime; do not run it alongside another browser run, desktop build or smoke using the same output. The full `test:e2e` command includes these tagged cases automatically.

CRUD route tests cover message retries/client-ID scoping, edits/deletion/counts/cascades, task status filters and atomic rejection of invalid dates, and knowledge upserts/deletion while keeping internal tool memories isolated. Search HTTP tests exercise the actual installed Tavily adapter, source normalization, upstream 403/500 conversion, the existing 12-second timeout against a deliberately stalled socket, and recovery on the next request. They check exactly one execution log and no successful memory on failure. They do not shorten production timeouts or directly throw a timeout in place of waiting for the adapter.

These cases are discovered by the existing CI `test:server`, `test:e2e` and desktop smoke commands; no additional CI job, dependency, browser download or deployment infrastructure is required for local validation. A local pass is not a GitHub Actions result.

Chat module regressions also exercise the browser API client's error parsing and attachment/reference contracts, automatic tool-intent gating with a deterministic model, preference normalization, manual tool fields, and shared memory ranking against isolated SQLite. Context recall retains its recency/manual weights and tool memories; explicit knowledge search retains smaller candidate limits, excludes tool memories, and merges built-in knowledge. Both now use normalized Chinese segmentation and bounded recent/lexical candidate sets. Tests verify older Chinese matches remain retrievable behind more than 100 unrelated newer records, scoring runs once per candidate, and ties remain stable without requiring a particular ICU dictionary split.

Browser lifecycle regressions cover switching conversations while old history succeeds or fails late, restoring per-conversation controls, creating/renaming/deleting conversations with confirmation, and video asset-reference persistence across reload. The video UI fixture does not validate video decoding or a live provider. The existing real image upload/persistence chain and Electron smoke remain responsible for actual private asset storage and desktop compatibility.

Pagination regressions use real SQLite with more than two pages, equal timestamps, cursor-anchor deletion, invalid limits and invalid cursors. They verify newest-first conversation traversal, chronological message pages, count-only detail reads and regeneration snapshots limited to the affected tail. Browser fixtures cover explicit page loading, duplicate boundaries, saved selection outside the first page, and late older-page responses after switching conversations. Those fixtures test UI behavior; route tests cover database pagination. See [Local API contracts](local-api.md).

Model catalog checks run inside `test:server` with synthetic provider snapshots; they validate structure, explicit defaults and removal/capability warnings without checking live availability. `npm run models:check` is also available for maintainers. Desktop logger tests cover byte/file bounds, legacy oversized logs, credentials split across chunks, Unicode decoding and excessive lines. The real Electron smoke confirms Next output uses the bounded/redacted writer after service restart.

`npm run test:desktop:dev` exercises the same smoke assertions against Next development mode. Both development and standalone smoke runs isolate Electron userData as well as SQLite/media, override inherited desktop path/runtime choices, and use the invoking Node executable for development. Run them sequentially after browser tests/builds; neither needs an installer or paid model.

The chat page composes views from `src/features/chat`; hooks own browser state while `api-client.ts` owns HTTP serialization and API errors. The chat route composes `src/lib/chat` request, context, intent, streaming and persistence modules. Browser modules must not import database/provider implementations. Extracted domain modules use the existing `@/` imports, which are understood by both Next.js and the test loader; no loader workaround or new test runner is needed.

`test:server` invokes the actual Next.js request handlers with `NextRequest`; it does not run an HTTP server. It therefore does not replace browser-to-server, reverse-proxy, installer, or live-provider testing. The TypeScript resolver and model override live exclusively under `tests/helpers` and are loaded only by the test command. The application contains no test-provider switch.

Tests are TypeScript and type-checked. Application code keeps the strict root `tsconfig.json`; `tests/tsconfig.json` extends it with `noImplicitAny` off and its own include, and `npm run typecheck` runs both, so a wrong import path, a renamed export or a mistyped helper argument fails before the suite runs. The root config excludes `tests` so the two settings do not drift into each other.

The test loader maps `next/server` and `next/headers` to their `.js` entrypoints through `nextResolve`. Do not call `require.resolve()` inside the synchronous resolve hook: it re-enters that hook on newer Node.js versions and can overflow the call stack. Loader regression tests check both ESM and CommonJS entrypoints with a re-entry guard and run automatically with `test:server`.

SQLite concurrency tests use the same application client as Web and Electron, not a test-only connection override. The client enforces `connection_limit=1`, `pool_timeout=30`, and `socket_timeout=5` while preserving the database path and other datasource parameters. Interactive transactions also wait up to 30 seconds to acquire a connection; their execution timeout is not extended. This bounds waiting without retrying failed writes or hiding database errors.

One regression holds an application write transaction for 6.5 seconds (longer than SQLite's 5-second lock timeout), then verifies eight concurrent memory upserts and another transaction all finish, leave one memory row, and allow subsequent writes. Another holds a lock from an independent SQLite connection, expects `P1008`, and verifies recovery after releasing it. That negative test expects a bounded database error and verifies recovery; raw Prisma diagnostics are suppressed to avoid logging query values. Concurrent-write tests await all settled results before propagating any rejection, so failed operations cannot spill into later tests or database cleanup. These regressions run automatically through the existing CI `test:server` step; no extra package or workflow is needed.

Multipart fixtures are serialized to wire bytes before reaching the handler. This avoids racing Node's client-side FormData encoder when the server rejects and cancels an oversized request. A separate streaming test verifies that requests without `Content-Length` still hit the byte limit and cancel their source; the production limit is not bypassed or disabled.

Server tests create and clean their own temporary databases. Each browser run has a unique `.desktop-data/test/e2e-<UUID>/` directory containing its database, media and storage state, plus an OS-selected loopback port. The parent passes the same run identity and port to config reloads and workers; invalid inherited values are rejected. Global setup installs the pinned test-only access cookie in that run's storage-state file. Neither suite uses the development database. The standalone `test:db` command creates and cleans a temporary database by default; when `LOCAL_DATABASE_FILE` is already provided, it uses that explicit path instead. Use `db:migrate` when you intentionally need to migrate the development database.

Media tests cover authenticated file reads, range/HEAD responses, signature/type/size restrictions, remote-reference rejection, shared references, fresh cleanup grace periods after deletion, legacy import, path traversal, and Windows junction rejection. The small video provider fixture tests transport/storage, not actual video decoding. One browser chain uploads and stores a real PNG through HTTP, reloads it from SQLite-backed history, and verifies reference-safe deletion without mocking business APIs.

Another browser test exercises the image-generation UI's new asset response contract and persists/reloads the result using real message and media APIs; only the paid generation response is mocked. Storage statistics and cleanup eligibility are tested against actual route handlers and SQLite. Build preparation and verification reject fixtures containing user data; the legacy-video guard is checked before any output replacement.

Run lint, TypeScript, server tests, browser tests and a production build before accepting related changes. When the database schema changes, regenerate Prisma first with `npm run db:generate`, then run the desktop migration tests as well. Do not run `next dev` and `next build` simultaneously against the same `.next` directory.

Browser tests build, prepare `.desktop-runtime`, and start the standalone production server automatically. This avoids development hot reloads resetting a page during parallel tests and follows the project's standalone output configuration. The test environment blanks the model-provider key and uses a placeholder search key, never live provider credentials. Do not run browser tests alongside desktop builds or smoke tests that use the same generated runtime.

`desktop:build` verifies only the runtime it just prepared, not a possibly stale installer/package from an earlier build. Run `desktop:verify` after packaging to check the packaged application too. Local database verification also checks asset/reference persistence and user-deletion cascades; it does not write media files.

## Conversation behavior covered by regression tests

- Recent assistant answers remain available to follow-up questions.
- Sending from an empty conversation waits for the newly activated SDK chat and its initial history before starting the stream, so the draft instance and history fetch cannot discard the first reply.
- Refreshing restores the last selected conversation even when a newer conversation exists.
- Older tool results are historical context, not fresh tool calls or approvals.
- Long conversations retain the active turn and bounded, explicitly incomplete excerpts. These excerpts are not model-generated summaries and do not guarantee recall of every older detail.
- Approval metadata survives history loading. Approval decisions are matched to persisted pending calls and atomically claimed before executing a tool; replayed or modified decisions are rejected.
- Completed approval continuations update their existing assistant message rather than inserting duplicates.
- Approval processing favors at-most-once execution. An interrupted continuation is not automatically replayed; reload the conversation and check the task state before requesting a new action.
- Regeneration retains old replies until a successful stream finishes. Failed streams and concurrent edits do not erase the original history.
- Aborting a real handler stream marks partial normal output as an error and leaves a regeneration's original answer intact; tests drain stream/persistence work before checking or closing SQLite.
- Editing a user message persists the edit and starts regeneration. A failed generation can leave the previous answer in storage until a later successful retry.

## Memory migration

The unique `(userId, key)` migration keeps the most recently updated duplicate under the original key. Older entries are retained with a ` [duplicate:<id>]` suffix; collisions receive additional underscores. No memory values are deleted. Desktop startup creates a backup before applying an unapplied migration to an existing application database.

`db:migrate` uses the same local migration runner as desktop startup. It snapshots an existing local database, applies pending migrations, and verifies the resulting schema. Automated tests apply migrations only to isolated databases.

## Remaining validation boundaries

Document regressions import actual generated PDF/DOCX and UTF-8 text/Markdown through both handlers and production HTTP. They cover incremental chunk reuse, reindex repair, atomic failure, the credential boundary, compressed expansion, quotas, parser timeout/cancellation, source snapshots and deletion. A fixed eight-query Chinese/English retrieval corpus reports Recall@3 and MRR@3 (required baseline: 1.0 each), with forty newer distractors, four empty-result queries and four collection checks. Run it through the normal server suite; no separate evaluation framework is needed.

The desktop migration regression upgrades an existing database, checks its backup and preserved chat, then verifies document/index persistence and deletion cascades. Electron smoke imports a real synthetic PDF and DOCX and checks extracted text, page references, authenticated reads and search after a service restart. Binary fixtures are generated from code, contain no private documents and make no model requests. These checks exercise parser runtime dependencies in the prepared standalone artifact, not just the source tree. The existing CI server/browser/desktop commands include these regressions; no new CI service or secret is required.

These tests do not certify every real OpenRouter model, network outage behavior, or clean-machine installation/uninstallation. Desktop path isolation and restart persistence are tested, but a full installer upgrade/uninstall cycle remains a separate check. Distinguish the real media HTTP/SQLite chain from the mocked UI tests when reporting coverage.

## Chat interaction regressions

`tests/server/execution-history.test.ts` checks independent execution evidence,
concurrent retry refusal, current permissions, scheduled execution exclusion,
restart interruption, sensitive-field exclusion, retention and restore behavior.
`tests/e2e/execution-history.spec.ts` exercises settings history, manual retry,
diagnostic download, evidence after schedule deletion and desktop service restart.
These tests use isolated SQLite data and no paid providers.

`tests/server/tool-contracts.test.ts` checks disabled-memory write refusal,
atomic step reservations across concurrent tool sets, refusal after reservation
failure, exact collection names, cached summary reuse without another model
call, and model-removal waiting through stream completion, failure and
cancellation. Backup tests cover escaped scopes; browser tests select a
collection containing `|` and retain its selection after reload. These tests
run with the existing CI commands and need no paid-provider credentials.

`tests/server/deepseek-tools.test.ts` exercises the real DeepSeek adapter, AI SDK
tool loop, chat route and temporary SQLite database against a local protocol
fixture. It checks that streamed and persisted assistant message IDs agree and
covers task approval, denial, duplicate approval refusal, persisted
tool output, and automatic/manual search respecting collection and memory
settings. Adapter tests also check complete tool-call events, interleaved argument
fragments, and refusal to execute a truncated stream.

`tests/e2e/tool-execution.spec.ts` verifies that a response containing only a task
call displays approval controls immediately, creates exactly one task after
approval, updates the task panel, and survives reload. It also imports real text
documents and checks scoped tool results and citation links. Provider responses
are deterministic HTTP fixtures; these are not live-provider certification.

`tests/e2e/chat-startup.spec.ts` covers three paths that had no automated protection before:

- **An unsent draft** is parked when the conversation is switched away, restored when it is switched back, still there after a reload, and cleared once a sent message has actually been answered.
- **Stopping a turn** replaces the send control, returns the composer to a sendable state, and does not put the question back into the input.
- **Reasoning display** puts a collapsed block above the answer, keeps it out of the answer text, and leaves the answer intact when it is expanded.

`tests/e2e/media-storage.spec.ts` covers image generation and attachment upload persistence and protected reads.

## Interface walkthrough

`tests/server/scheduled-workspace.test.ts` uses the real model middleware with a
deterministic provider adapter. It verifies restore deferral without consuming
a due job, paused schedules, mutual exclusion during generation, exactly one
usage record with configured token pricing, recorded-period prompts, and gate
release on provider failure. Backup tests round-trip the maximum accepted
collection scope; directory-grant tests reject an approval bound to a different
folder. These tests run under the existing `test:server` CI command.

`tests/e2e/interface-walkthrough.spec.ts` captures the build at the sizes the acceptance list names: 1440px and 390px widths, light and dark themes, 125% and 150% text scaling, keyboard focus, and scrolled to the top.

It also asserts what can be asserted without eyes: no horizontal overflow at either width, and the composer and its send control still visible and reachable at 390px and 150% scaling. **It is not a visual sign-off.** The screenshots need a person; a passing run here does not mean the walkthrough passed.

## Workspace review regressions

`tests/server/workspace-review.test.ts` covers calendar windows across daylight
saving transitions and skipped midnight, atomic event writes and rollback,
no-op/concurrent mutations, historical counts after source changes or deletion,
partial coverage, empty periods, model failure, period reuse, interrupted
commentary, retention and new/legacy backup restoration. The model adapter is
simulated; no paid provider is called.

`tests/e2e/workspace-review.spec.ts` runs the prepared production HTTP server
against isolated SQLite without a configured model. It completes a seeded task
through the real API, verifies repeated completion produces one event, then
places its timestamp in yesterday's window to test preview and source navigation.
It checks deletion evidence, no model requests, desktop/mobile layout and weekly
selection. Screenshots are supplementary visual evidence, not production
provider or installer certification. Existing CI commands discover these tests.

## History and citation integrity

### Hybrid knowledge retrieval

ESLint excludes generated Playwright reports, traces and result directories so
failure diagnostics do not become lint inputs on subsequent runs. Application,
test and harness source files retain the existing lint rules.

`tests/server/document-rag.test.ts` verifies semantic-only paraphrases, required
exception evidence, heading-context invalidation, conflicting documents, scoped
full-corpus vector ranking beyond two 64-row pages (1,536 dimensions), model
and dimensional isolation, unchanged-index reuse, cancelled/obsolete/duplicate
work, failure recovery without automatic retries, explicit authenticated indexing,
follow-up user context, actual versioned answer links and portable backup restore.
The fixed four-domain corpus reports lexical Recall@8, hybrid Recall@8,
required-fact coverage and unrelated empty results. Synthetic vectors measure
mechanics and do not certify a live embedding model.

`tests/e2e/document-rag.spec.ts` exercises the production standalone service and
real provider adapter with network-disabled protocol fixtures. It checks explicit
indexing, no repeat charges for completed chunks, partial-batch progress/recovery,
semantic preview, desktop/mobile layout, evidence in the provider request, actual
streamed citations, unused references, persisted metadata, restart and disabled
embedding selection. The controlled answer fixture verifies transport and link
tracking rather than live reasoning quality. Screenshots stay outside the repository.
`tests/desktop/document-semantic-migration.test.ts` checks legacy chunk/term
preservation, default values, a pre-upgrade SQLite snapshot, deletion cascades and
idempotent restart. Existing CI globs include these tests; no new service, native
extension, dependency or secret is needed. See [Document knowledge](document-knowledge.md)
for explicit live-model evaluation and its billable data flow.

`tests/server/history-integrity.test.ts` exercises edits, deletion, regeneration,
replacement and a blocked model call racing a real edit. It also checks that approval metadata, reasoning and attachment bytes are not
forwarded to compression, and that valid earlier summaries survive a paginated
history window. It verifies that stale
compression cannot commit and that the next request uses corrected stored text.
`tests/desktop/summary-migration.test.ts` checks the pre-upgrade snapshot including uncheckpointed WAL commits, retained
original messages, cleared unverifiable compression and idempotent restart.

`tests/server/document-references.test.ts` checks preserved chunks in changed
documents, unchanged reindex, deleted/recreated filenames, old unverified sources,
collection moves, bounded authorized APIs and portable source/link restoration.
Reminder regressions inject notice-write failure to verify rollback and one notice
per accepted claim. They do not certify native OS display.

`tests/e2e/document-versions.spec.ts` uses production HTTP, isolated SQLite and a
local model protocol fixture. It exercises exact collection selection, local
search without a model, citation consistency, change warnings for retained chunks,
current-source navigation, deletion evidence, reload/service restart and mobile
layout. Screenshots are saved outside the repository. Fixtures are not live paid
provider or installer validation. Existing CI commands discover these tests.

The execution-history browser suite also claims a reminder through the authenticated
desktop HTTP boundary and verifies its durable settings notice across restart,
without claiming that an OS notification was displayed. Post-account workspace
migrations now snapshot from SQLite itself (`VACUUM INTO`) before changing data;
this preserves committed WAL data instead of copying only the main database file.


Model call regression coverage uses isolated SQLite and the real observer with mock provider streams: concurrent admission, unknown pricing, estimated ceilings, pre-cancellation, cancellation during a pending read, restart recovery, late settlement and cache pricing. The HTTP proxy regression uses a real local proxy and local endpoint, exercising global fetch with conflicting inherited proxy values. Browser usage tests exercise a real built service and offline provider fixture, settings persistence, source filters, unsaved edits and offline task persistence.

Desktop resume tests simulate health outcomes, coalesced wakeups and replacement/quit races; the Electron smoke executes healthy recovery. Release-artifact tests validate root version synchronization and SHA-256 metadata without claiming a clean install. Physical sleep, native OS notification visibility and an installer upgrade on a clean Windows VM remain manual acceptance checks. CI configuration is updated locally; a local pass is not a remote CI result.

`tests/desktop/release-acceptance.test.ts` exercises the actual acceptance CLI and file hashing with synthetic artifacts/evidence in system-temporary directories. It checks all ten required scenarios, unverified initialization, refusal to overwrite records/receipts, same-version rebuild and version mismatch rejection, unsafe installer paths, failure/unperformed statuses, environment/preceding-version requirements, missing/empty evidence and timestamp validation. A successful synthetic record proves the checker contract only; it is not real Windows installation evidence. The existing `test:desktop` command automatically includes these tests. CI initializes and uploads an unverified manual record after MSI verification; completion requires the VM procedures in [Windows release acceptance](windows-release-acceptance.md).

`tests/desktop/windows-installer.test.ts` generates a real WiX source using the configured maker options and checks selectable destination, stable upgrade identity, per-user installation, matching notification identity, and removal of recursive directory purge. After making and recording the installer, `scripts/verify-windows-installer.ps1` opens the compiled MSI database read-only and checks version, language, upgrade code, feature destination/Browse wiring and absence of recursive purge actions; CI runs it before upload. Release-artifact tests check versioned MSI naming, obsolete-artifact exclusion, repeatable checksums and unverified acceptance status. These tests do not perform a real install/uninstall or certify migration from Squirrel; follow the Windows release acceptance document for those checks.


### Dependency security

Directory-grant regressions check blocked credential subtrees even when their selected paths do not exist, avoiding dependence on a developer's populated home directory. Grant creation checks both the selected absolute path and the canonical real path: ordinary missing paths retain `not-found`, while aliases into protected locations remain blocked.

Failed Electron smoke runs print the bounded tail of the redacted application log and retain their isolated directory. The desktop CI job uploads only `desktop.log` and its rotated archives from smoke directories, including hidden paths; settings, SQLite databases and Chromium profiles are excluded. A missing log is explicitly reported. A timed-out process cannot become a passing result by later exiting with code zero. Desktop diagnostics tests launch a failing child to verify the error reaches the command output and failure data is retained.

`npm run test:desktop:smoke -- --maximized` starts the isolated smoke window maximized before loading the renderer; CI exercises this state separately. Both caption checks recognize the middle control as either maximize or restore, and the trusted-click check requires an actual native maximization-state change instead of treating full screen width as evidence of a working click.

Dependency security changes require a clean `npx --yes npm@11.19.1 ci` and the full `npm audit --audit-level=low`, including development dependencies. Keep the project `.npmrc` and `vendor/` in that checkout. `tests/server/dependency-security.test.ts` exercises excessive brace nesting, caller-provided cyclic/shared ASTs, unsupported numeric precision, normal formatting and installed Micromatch, Mammoth and argparse consumers. See [Dependency security backports](../vendor/README.md) for the upstream sources and compatibility limits. An audit result alone does not validate these private backports.

Desktop runtime preparation includes the production formatter source and license. Runtime/package verification resolves it from Mammoth's actual location, requires it to stay inside the bundle and exercises its precision guard. Bundle regressions reject an unpatched nested consumer or a missing license. The settings-store Electron runner uses the repository as its working directory, keeping its disposable data directory independent of transient native helper handles.

Next.js scoped response caches generated during smoke/browser tests are stripped from the staged installer alongside the image cache. Bundle tests seed both caches independently of a previous build and verify removal while retaining immutable prerender responses and ownership metadata. Validate a fresh packaged smoke after changing these paths; changing cache keys or dropping immutable response seeds would invalidate Next.js route isolation.

### Workspace layout and refresh

`tests/desktop/make-desktop.test.ts` verifies automatic WiX preparation, case-insensitive Windows PATH handling without mutating the parent environment, reuse of an already built CI runtime, and stopping before packaging or release evidence after a failed prerequisite.

The chat layout regression fills short text and forty-line drafts at desktop, compact and mobile widths, verifies unchanged textarea and composer bounds, and scrolls long drafts inside the fixed input. It also verifies that the chat workspace reaches the right viewport edge: the non-scrolling outer chat container must not reserve a scrollbar gutter. Scrollbar space remains reserved inside scrolling transcripts and ordinary workspace pages.

`tests/e2e/workspace-layout.spec.ts` starts an isolated standalone service and checks initial task skeletons, retained task content on a delayed refresh, unchanged composer bounds, internal scrolling, compact-panel controls, and saved theme restoration. It captures chat at 1440, 900 and 390 pixels and other workspace pages under the temporary `ria-workspace-ui` directory. `chat-startup.spec.ts` verifies transcript follow behavior and keeping the reader's position during a streamed answer. These checks require rebuilding and preparing the standalone runtime after UI edits. `tests/desktop/window-appearance.test.ts` covers native Windows transparency options and opaque behavior on other platforms; it does not prove the compositor visually exposes desktop content.


The layout test also verifies navigation focus containment, animated/saved conversation rail widths, creating a task on the independent tasks page, immediate completion feedback and rollback after a rejected save. A renderer test simulates preload presence to check that only the upper chat canvas is translucent, other pages and the dock are opaque, overflowing home content remains scrollable, and execution history can be expanded/collapsed. Desktop smoke samples captured alpha values for opaque navigation/titlebar/dock and a strongly tinted translucent main canvas, including after maximize/restore and resizing. Native appearance tests check the Windows 11 22H2 material guard. This checks native capture output; actual Acrylic appearance on Windows 11 and final contrast against varied desktop backgrounds still require human review.

## Test stability and failure diagnostics

Browser tests use zero retries. The first failing attempt retains its Playwright trace and screenshot, rather than waiting for a retry to collect evidence. Each run writes `test-results/e2e-<UUID>/results.json`, attachments under that run's `artifacts/` directory, and an HTML report under `playwright-report/e2e-<UUID>/`. Reports do not open automatically. The run ID and origin are recorded in report metadata. The serialized web-server configuration contains only explicit test overrides, never a copy of the inherited process environment; Playwright performs normal environment inheritance when launching the server. A synthetic-secret regression protects that boundary. Open a trace with `npx playwright show-trace <trace.zip>` or a report with `npx playwright show-report playwright-report/e2e-<UUID>`. CI uploads these report trees after failure with seven-day retention; it does not upload the isolated workspace database, encrypted settings or browser profile.

Isolated HTTP fixtures capture stdout/stderr through the existing bounded desktop log sink, including split-line credential redaction. A failed startup includes the exit code or signal and up to 8,000 characters of the redacted log tail. Startup failures and failed-test fixture teardown attach the redacted server log before deleting their temporary workspace. Logs are capped at 256 KiB plus one rotated archive. A server that cannot be stopped keeps its workspace and reports failure rather than deleting data beneath a live process. The diagnostic fixtures use synthetic data; traces and screenshots are test evidence, not general-purpose production support exports.

`npm run test:e2e:diagnostics` deliberately fails one nested, isolated Chromium test and requires exactly one attempt, a readable trace ZIP, a PNG screenshot, JSON/HTML reports, and a redacted server-log attachment from failed fixture teardown. The outer test passes only when those artifacts exist. It uses the installed Playwright browser, temporary fixtures and local SQLite; it needs no live provider keys. CI runs it after installing Chromium, and `npm test` includes it. `tests/e2e/server-diagnostics.spec.ts` additionally verifies startup failure evidence and redaction through the real isolated-server helper.

The desktop cancellation regression waits for an actual live fixture worker while health is still unavailable, then cancels startup and requires both launcher and worker to exit. It no longer assumes the worker starts within 400 ms. Scheduler registration/restart tests likewise wait for persisted completion, require one execution record and await subsequent explicit polls instead of assuming work finishes within 150 ms; timer ownership is checked on repeated registration. Schema checks each own a `ria-schema-check-*` directory in the system temporary directory, close SQLite even after migration failure and remove only their directory. Real subprocess regressions cover simultaneous checks and failure cleanup. This allows lint and schema validation to run together without deleting a directory ESLint is traversing.

Run-specific workspace and report paths prevent stale data or diagnostics from a previous browser run being reused. They do not isolate `.next` and `.desktop-runtime`: builds and full browser runs sharing one checkout must still run sequentially, as described above. An OS-selected port is checked again by Playwright's web-server startup; an intervening process taking it produces a startup failure, not a reused foreign service. Local report and test-workspace directories remain available for inspection; remove old runs when no longer needed. Desktop tracing, runtime preparation and package verification exclude/reject browser diagnostic directories so test reports cannot enter the shipped runtime.
