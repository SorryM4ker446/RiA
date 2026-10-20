# Test coverage and local validation

CI regressions distinguish an unavailable executable from PowerShell module
command discovery. The terminal fixture invokes a file-qualified missing binary
under both restricted and permissive child-process policies, checks a nonzero
exit and visible stderr, and proves a same-named module remains loadable. Module
search-path overrides are restored, and policy commands use only child-process
scope; product terminal policy and installed-tool discovery are unchanged.

Document attachment browser tests wait for the enabled file entry point after
reload. Playwright can dispatch `setInputFiles` on a disabled input; a load event
alone does not mean preferences and conversation identity have been restored.
Separate gated tests still require selection, paste and drop to be refused while
restoration is incomplete, and late-send failures must preserve both drafts.

Windows desktop smoke checks sample transcript padding measured from the DOM,
rather than fixed positions that can contain opaque messages or skeletons. Image
dimensions and bitmap bytes use the same scale representation. Opaque navigation
and composer, translucent caption/dock and all three empty canvas samples remain
mandatory; invalid geometry or bitmap storage is an error. Tests cover wide,
narrow and resized layouts, opaque content over the former probes, and an opaque
canvas that must not pass. A failed check retains pixel values, geometry, computed
surfaces and `data/logs/transparency-failure.png` in the synthetic smoke profile;
CI uploads this screenshot alongside desktop logs with seven-day retention.

Approval-card regressions verify decisions above the composer without automatic
sheet opening, sequential approval queues, exact terminal command review,
rejection, reload, execution-once behavior and narrow layouts. Run-detail tests
cover server-owned continuation links, one combined request entry, legacy file
details, ambiguous-history refusal and explicit missing-detail summaries. Pending
approvals remain individual decisions; no approval or command is replayed during
history reconciliation. The message payload adds optional `runIds`; no schema
migration, CI service or new dependency is required.

Search-count regressions cover model-selected counts above ten, sequential and
parallel requests without a RiA result-count quota, provider API ceilings,
structured count planning and its cancellation/failure paths, and synthesis using
all selected evidence. Manual search browser coverage verifies the count field is
absent and the selected model's plan reaches the provider transport.

Execution-record browser checks cover compact single-line rows, full requests on
expansion, independent scrolling in short windows, keyboard focus restoration,
preserved drafts, individual tool disclosures, approval continuation, terminal
output and expandable sources. Compact source and diagnostic presentation is
scoped to execution details; other knowledge surfaces retain their defaults.

RiA plugin packages are covered by `plugin-packages.test.ts`,
`plugin-packages.spec.ts` and `plugin-migration.test.ts`. They exercise inactive,
atomic installation; strict manifests and preview digests; credentials and process
consent; instruction/connection bounds; ownership and cascade uninstall; stale
approvals; active-call cancellation; real chat prompt inclusion/removal; both HTTP
and MCP approval; restart persistence; import validation and responsive animated
sheets. Backup tests ensure portable restore disables retained local packages.
Fixtures use synthetic credentials, local services and deterministic model replies.
The Browser plugin is unavailable; rendered checks use Playwright, with screenshots
outside the repository under temporary `ria-plugins-qa`. Existing CI globs include
these tests. No dependency or workflow change is required.

Document-processor tests cover PDF/Word/Markdown/TXT extraction without importing
or calling a model, four download formats, DOCX read-back and literal symbols,
scoped chat tools and obsolete source versions. Renderer cases check actual file
downloads, isolated preview, narrow layouts, cancellation/stale responses, error
recovery and tool-result downloads after restart. Screenshots and generated test
files stay under the OS temporary directory (`ria-document-processor-qa`). The
responsive regression checks that creating a draft is reachable in the first
narrow viewport, editing precedes export settings, replacement can be declined,
and dropdowns close on a second click without shifting their triggers. Light
themes, preview transitions and reduced-motion behavior are also exercised. The
preview intentionally disallows scripts, including automation recorder injection;
tests permit only that exact Chromium diagnostic and still require no script
elements, external image requests or other application console errors.

Chat tool regressions distinguish actions from document resources, select a
document by filename within the conversation's collections, retain failed action
parameters, and return to automatic tools after a successful explicit action.
They load obsolete manual-only preferences and verify that later model turns
still offer other tools with their normal approvals. The composer retains its
672px desktop width and uses an 80px scrolling text area. Persisted model choices
and assistant restrictions remain covered by conversation-switching tests.

Extension regressions use real loopback HTTP and MCP JSON-RPC services, plus a
local stdio process. They check discovery, mandatory approval, denial, stale
configuration, cancellation, bounded responses, timeouts, credential encryption
and isolation, and existing manual-tool behavior. The production-renderer tests
cover management, narrow windows, connection failures, restart and chat history
after uninstall. Long unbroken names must remain inside cards and tool sheets
without overlapping status labels; drawers must restore focus and respect reduced
motion. Migration tests retain existing conversations and verify safety
copies; portable restore disables machine-local connections without exporting
their settings or credentials. These fixtures do not establish compatibility with
every third-party MCP server or a plugin marketplace. See [Extensions](extensions.md).

Document structure regressions run actual generated Word files through the bounded
worker and verify headings, amounts, row/column relationships, literal untrusted
text, unmarked first rows and escaped delimiters. Table chunk tests require repeated
headers, complete rows, bounded size and unchanged ordinary-paragraph identities;
oversized rows must preserve the saved version. Preview tests cover authentication,
no writes or embedding calls, extraction mismatch, concurrent creation/content
change/collection move and deleted/recreated identities. Vector summaries check
context hashes and malformed/model-mismatched data before selective repair.
Maintenance tests exercise persisted 32+8 batches, cancellation, quota/conflict
stops, individual failures, local-index upgrades and the 12-request ceiling.
Regressions also require fenced heading examples to leave later evidence under
its real section, with reindex repair preserving IDs and invalidating wrong-context
vectors. Compact table rows ending in an escaped backslash must retain their
closing delimiter and repeated headers without losing or duplicating rows.

`tests/e2e/document-structure.spec.ts` uses production standalone HTTP and isolated
SQLite. It checks read-only preview, discard/confirmation, Word table evidence after
restart, optimistic save conflicts and two-document bulk cancellation/resumption.
Markdown code examples and compact escaped paths must also retain correct section
paths and table headers through the production preview, save and retrieval flow.
Request gates hold the second batch after the first commits; no sleeps or retries
mask the boundary. Provider calls are offline fixtures. Desktop and 390-pixel
screenshots and page/console checks validate the rendered preview. Existing document,
RAG, citation, template and refresh cases use the same confirmation workflow.
No live provider accuracy or real Windows installer acceptance is implied.

Assistant template tests cover immutable conversation snapshots, explicit update,
read-only built-ins, stale revision rejection, bound-model validation, server tool
restrictions (including an empty allowlist), scoped chat evidence and portable
restore. Retrieval diagnostics tests cover missing indices, provider outages,
thresholds, excerpt budgets, conflicting clauses in one document, empty-result
metadata and evaluator input/cancellation boundaries. Expected facts stay outside
the answer prompt; citation matches and fact coverage are contract checks, not
semantic correctness judgments.

Optional model review adds structured facts/conditions/exceptions/quantities/
conflicts plus grounding, citation support and refusal criteria. Server regressions
cover a negated answer with perfect literal coverage and a valid citation, correct
refusal despite related evidence, uncertain verdicts, opt-in and model validation,
malformed output, invented quotations, missing/duplicate checks, review failure
with preserved answers and cancellation before the next question. They validate
the assessment contract using controlled judge responses, not model intelligence.
The 50-question `document-quality-evaluation.json` corpus covers eight documents,
five expectation kinds, English and Chinese, conflicts and ten unanswerable cases.
All 40 named-document questions must retain filename recall in local keyword
retrieval; missing facts with related hits must remain distinguishable from empty
retrieval. Its six answer pairs support manual/live judge calibration.

`tests/e2e/assistant-templates.spec.ts` runs the production standalone application
against isolated SQLite and offline HTTP provider fixtures. It checks template
creation/edit/copy/delete, explicit snapshot update, service restart, model picker
binding, manual tool refusal and the evaluation UI/report. Desktop and 390px
template detail drawers keep snapshot versions and tool counts out of the chat
header while preserving the saved version after template edits, deletion and
restart; keyboard focus, opening transitions and reduced motion are verified.
Desktop and 390px
screens also show semantic-review reasons and source quotes. UI checks verify
review opt-in/reset, paid-call confirmation, refusal results and template-loading
failure/retry using a deliberately invalid response. These fixtures simulate
responses only; semantic evaluation against a real model is separately billable.
The template-loading failure case uses the global setup's access cookie to enter
the knowledge page directly and verifies that the malformed response belongs to
a request from that page.
Opening chat first can let its delayed hydration request consume the one-shot
fault before the evaluation component requests templates.
Template prompt assertions wait for the actual provider IPC record; start metadata
can reach the renderer before that record arrives, so seeing retrieval diagnostics
alone does not establish that a model call has been observed.
Desktop and 390px screenshots are saved outside the repository under the OS temporary directory
(`ria-assistant-qa` and `ria-retrieval-evaluation-qa`). The browser plugin is not
available in this environment, so validation uses the project's existing Playwright
harness. Desktop migration tests verify pre-upgrade safety copies and idempotent
restart. Live evaluation requires a deliberate application action and may be billed.

Use Node.js 24.9.0 and the dependencies already installed for this project. No separate server or desktop testing framework is required.

The application ships as a Windows desktop program; there is no browser or web deployment target. "Browser tests" below means a Chromium renderer driving the application's own HTTP surface — the same renderer the desktop shell embeds — and is a description of the harness, not a supported form of the product.

All CI execution jobs pin Node.js to 24.9.0 and install with npm 11.19.1. When upgrading the runtime, update every `actions/setup-node` step in `.github/workflows/ci.yml` and revalidate with that version. A local pass still does not replace a GitHub Actions run.

CI runs static/database checks, browser workflows and three server-test shards independently. Each server shard uses Node's `--test-shard=N/3` with `--test-concurrency=2`, retaining per-file process/SQLite isolation and all assertions. The matrix disables fail-fast so a failed shard does not cancel the others. Browser checks keep two workers on the hosted runner, zero retries and the existing timeouts. The existing **Validate application and local database** check aggregates all three groups and fails on a failed, cancelled or skipped dependency; branch protection can continue using that check name. Desktop packaging remains a separate required check where configured. Splitting reduces the sequential path; actual wall-clock improvement depends on runner availability and must be measured in Actions.

For local reproduction of a CI server shard:

```powershell
node --import ./tests/helpers/register-typescript.ts --test --test-concurrency=2 --test-shard=1/3 tests/server/*.test.ts
```

Run shards 1, 2 and 3 to cover the whole server suite. A single shard is not a full-suite pass. The normal `npm run test:server` command still runs every file.

Chat approval browser tests require pending tool details to be open immediately, then verify that approval or denial sends exactly one continuation. Tool output can render before the end-of-stream database write; the persistence test waits for the completed tool state in the history API before reloading, then requires the restored result and exactly one task. Title-row geometry tests cover the current 44px row, content and conversation rail below it, rail collapse/expansion, and navigation to the independent tasks page.

Attachment restoration coverage holds the initial conversation-list request after hydration, asserts the file input is disabled, and dispatches file-selection, paste and drop events while it is held. No upload may start. Once restored, a PDF must upload exactly once, stay attached after reload and leave the knowledge library unchanged. The existing mixed PDF/DOCX/image case waits for the usable attachment control rather than textarea visibility; upload isolation across conversation/mode changes and failure-lock release retain unit coverage. The Browser plugin is unavailable; the repository Playwright harness exercises this rendered flow.

Windows installer tests generate the real WiX template and require per-user scope, stable upgrade identity, safe uninstall and default verbose logging, while rejecting rollback-disabling or elevation-policy changes. The read-only diagnostic-script regression uses a synthetic failure log and verifies relevant lines are extracted without echoing unrelated properties or changing fixture files. Template compilation/property checks remain separate from real installation/upgrade acceptance on the affected machine.

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

The test-only `offline-http.ts` preload intercepts fetch in those child processes using the existing Undici dependency. It uses matching fetch/dispatcher versions, bridges native Request/Response, denies unmatched destinations and endpoints, and emits synthetic model prompts over IPC for context assertions. It does not store request headers or add a test switch to application code. A server regression checks both provider-disabled and simulated-provider modes and rejects unmatched external and loopback fetches. This guard covers fetch, not every possible socket API; Tavily is disabled in these browser fixtures, while autonomous provider-search tests use an offline OpenRouter server-tool response. Separate search HTTP tests point Tavily explicitly at an isolated loopback server.

Run `npm run test:e2e -- --grep '@integration'` to select authenticated HTTP/SQLite flows, or add `--repeat-each=3` to check repeatability. Quote the tag in PowerShell to avoid splatting. This still builds and prepares the production runtime; do not run it alongside another browser run, desktop build or smoke using the same output. The full `test:e2e` command includes these tagged cases automatically.

CRUD route tests cover message retries/client-ID scoping, edits/deletion/counts/cascades, task status filters and atomic rejection of invalid dates, and knowledge upserts/deletion while keeping internal tool memories isolated. Search HTTP tests exercise the Tavily HTTP integration, source normalization, upstream 403/500 conversion, the existing 12-second timeout against a deliberately stalled socket, cancellation and recovery on the next request. They check exactly one execution log and no successful memory on failure. They do not shorten production timeouts or directly throw a timeout in place of waiting for the transport.

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

The desktop migration regression upgrades an existing database, checks its backup and preserved chat, then verifies document/index persistence and deletion cascades. Electron smoke imports a real synthetic PDF and a Word table, checks the literal row linking accommodation, 500 yuan and manager approval, and verifies extracted text, page references, authenticated reads and search after a service restart. Binary fixtures are generated from code, contain no private documents and make no model requests. These checks exercise parser runtime dependencies in the prepared standalone artifact, not just the source tree. The existing CI server/browser/desktop commands include these regressions; no new CI service or secret is required.

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

`tests/e2e/chat-documents.spec.ts` exercises real PDF/Word parsing through the chat paperclip, mixed image/document provider payloads, draft reload and application restart, original-file downloads, failed-send retry, late failures after conversation switching, generation-mode restrictions, compact mobile layout and reduced motion. Failed SDK requests retain the text and attachments instead of treating a resolved send Promise as success; completion results are matched to their user-message IDs. It uses the repository Playwright harness because the Browser plugin is not available. Server media and backup regressions additionally verify text-only model support, table extraction, malformed files, MIME spoofing, aggregate text limits, cancellation, reference protection and PDF/Word portable restore. These fixtures confirm that attachment handling does not create knowledge documents or chunks; provider replies are deterministic and do not measure live model analysis quality.

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

`tests/desktop/release-acceptance.test.ts` exercises the actual acceptance CLI and file hashing with synthetic artifacts/evidence in system-temporary directories. It checks all ten required scenarios, unverified initialization, refusal to overwrite records/receipts, same-version rebuild and version mismatch rejection, unsafe installer paths, failure/unperformed statuses, environment/preceding-version requirements, missing/empty evidence and timestamp validation. A successful synthetic record proves the checker contract only; it is not real Windows installation evidence. The existing `test:desktop` command automatically includes these tests. CI initializes an unverified manual record after MSI verification without uploading installer artifacts; completion requires the VM procedures in [Windows release acceptance](windows-release-acceptance.md).

`tests/desktop/windows-installer.test.ts` generates a real WiX source using the configured maker options and checks selectable destination, stable upgrade identity, per-user installation, matching notification identity, and removal of recursive directory purge. After making and recording the installer, `scripts/verify-windows-installer.ps1` opens the compiled MSI database read-only and checks version, language, upgrade code, feature destination/Browse wiring and absence of recursive purge actions; CI runs it as a validation gate without uploading the installer. Release-artifact tests check versioned MSI naming, obsolete-artifact exclusion, repeatable checksums and unverified acceptance status. These tests do not perform a real install/uninstall or certify migration from Squirrel; follow the Windows release acceptance document for those checks.


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


The layout test also verifies navigation focus containment, recent-conversation popover bounds, dismissal and focus restoration, creating a task on the independent tasks page, immediate completion feedback and rollback after a rejected save. A renderer test simulates preload presence to check a translucent chat canvas, opaque controls, scrolling when home content exceeds the viewport, and an execution-records sheet that preserves composer bounds. Desktop smoke samples captured alpha values for opaque global navigation/composer and the translucent chat caption, canvas and dock, including after maximize/restore and resizing. Alpha capture briefly shows the isolated smoke window without activating it, waits for finite UI animations and painted frames, then restores its hidden state. Chromium can flatten a hidden backdrop-filter surface to opaque pixels, so hidden capture cannot establish visible-window transparency. Native appearance tests retain coverage of rounded-corner options, Windows host configuration and the shared Windows 10/11 configuration without native frosted material. `workspace-polish.spec.ts` checks scroll-triggered catalog batches, idle behavior, searching beyond 300 entries, independent run-record scrolling, retained drafts, focus restoration, equal-height transparent header controls and menu-animation endpoints without position jumps. Shared Select/Popover/Dropdown primitives resolve to the same Radix dismissal layer to preserve nested Escape handling. `ui-transitions.spec.ts` covers dark first launch, saved light theme, theme-aware wordmark, preload hydration, keyboard focus, sheet transitions and reduced motion. `settings-layout.spec.ts` verifies persisted default-model readiness, clearing the selection, rejected writes, unknown status on read failure, preservation of unrelated preferences, field retention across tabs and compact layouts. `chat-lifecycle.spec.ts` exercises recent-conversation date groups, long titles, keyboard menus, rename and confirmed deletion at desktop and compact widths.

## Test stability and failure diagnostics

Chat startup regressions hold the conversation list response while the composer
already has text. Sending and Enter stay blocked until the saved conversation
is restored; the submitted request must use that conversation without creating
another. Separate history-failure checks retain the question, provide reload
guidance, refuse sending incomplete context, and verify recovery after reload.
Plugin package tests verify the intended conversation is active before exercising
approval, persisted tool results and uninstall. Knowledge retrieval tests create
their entry through the current **新增知识** drawer.

Browser tests use zero retries. The first failing attempt retains its Playwright trace and screenshot, rather than waiting for a retry to collect evidence. Each run writes `test-results/e2e-<UUID>/results.json`, attachments under that run's `artifacts/` directory, and an HTML report under `playwright-report/e2e-<UUID>/`. Reports do not open automatically. The run ID and origin are recorded in report metadata. The serialized web-server configuration contains only explicit test overrides, never a copy of the inherited process environment; Playwright performs normal environment inheritance when launching the server. A synthetic-secret regression protects that boundary. Open a trace with `npx playwright show-trace <trace.zip>` or a report with `npx playwright show-report playwright-report/e2e-<UUID>`. CI uploads these report trees after failure with seven-day retention; it does not upload the isolated workspace database, encrypted settings or browser profile.

Isolated HTTP fixtures capture stdout/stderr through the existing bounded desktop log sink, including split-line credential redaction. A failed startup includes the exit code or signal and up to 8,000 characters of the redacted log tail. Startup failures and failed-test fixture teardown attach the redacted server log before deleting their temporary workspace. Logs are capped at 256 KiB plus one rotated archive. A server that cannot be stopped keeps its workspace and reports failure rather than deleting data beneath a live process. The diagnostic fixtures use synthetic data; traces and screenshots are test evidence, not general-purpose production support exports.

`npm run test:e2e:diagnostics` first compiles the desktop migration runtime required by its isolated HTTP fixture, so it also works before the application build on a clean checkout. It then deliberately fails one nested, isolated Chromium test and requires exactly one attempt, a readable trace ZIP, a PNG screenshot, JSON/HTML reports, and a redacted server-log attachment from failed fixture teardown. The outer test also verifies that the nested test reached its intentional page assertion; a fixture startup failure cannot masquerade as the expected failure. It uses the installed Playwright browser, temporary fixtures and local SQLite; it needs no live provider keys. CI runs it after installing Chromium, and `npm test` includes it. `tests/e2e/server-diagnostics.spec.ts` additionally verifies startup failure evidence and redaction through the real isolated-server helper.

Installer diagnostic tests canonicalize temporary paths before comparison and cleanup, treating Windows 8.3 aliases and long names as the same directory. The missing-runtime terminal regression explicitly looks for an `Application` with `Get-Command`, requires a failed result, nonzero exit and the requested name in stderr, and uses a same-name PowerShell module fixture to verify that no module is imported instead. This isolates external executable discovery from machine-dependent module discovery without disabling application features, increasing timeouts or accepting a timeout as success. Existing terminal timeout, arbitrary-command, PATH discovery and approval tests remain enabled.

Document citation browser workflows explicitly expand **文档参考** inside the execution record before checking links and excerpts. They continue verifying the same source content after reload, service restart and document deletion; collapsed reference groups do not change the persistence contract.

The desktop cancellation regression waits for an actual live fixture worker while health is still unavailable, then cancels startup and requires both launcher and worker to exit. It no longer assumes the worker starts within 400 ms. Scheduler registration/restart tests likewise wait for persisted completion, require one execution record and await subsequent explicit polls instead of assuming work finishes within 150 ms; timer ownership is checked on repeated registration. Schema checks each own a `ria-schema-check-*` directory in the system temporary directory, close SQLite even after migration failure and remove only their directory. Real subprocess regressions cover simultaneous checks and failure cleanup. This allows lint and schema validation to run together without deleting a directory ESLint is traversing.

Run-specific workspace and report paths prevent stale data or diagnostics from a previous browser run being reused. They do not isolate `.next` and `.desktop-runtime`: builds and full browser runs sharing one checkout must still run sequentially, as described above. An OS-selected port is checked again by Playwright's web-server startup; an intervening process taking it produces a startup failure, not a reused foreign service. Local report and test-workspace directories remain available for inspection; remove old runs when no longer needed. Desktop tracing, runtime preparation and package verification exclude/reject browser diagnostic directories so test reports cannot enter the shipped runtime.

## Knowledge topic and artifact validation

`tests/server/knowledge-topics.test.ts` verifies authenticated topic configuration, exact scoped retrieval, immutable conversation defaults, citation snapshots, idempotent paid request IDs, insufficient evidence, invalid citations, provider failure, cancellation/concurrent deletion, obsolete topic/document work, interruption recovery, export contracts and backup remapping/old archive defaults.

`tests/e2e/knowledge-topics.spec.ts` exercises topic creation, index status, hybrid retrieval, a scoped conversation, confirmed artifact generation through the real SDK adapter against an offline HTTP fixture, downloads, topic updates, service restart, deletion and explicit load-failure recovery. Desktop and 390-pixel screenshots are saved outside the repository to the system temporary `ria-knowledge-topics-qa` directory. The Browser plugin is not available; validation uses the project's Playwright harness. Fixtures establish application transport/lifecycle behavior, not live-provider reasoning quality.

Run database and desktop upgrade tests for the additive migration. Keep production builds/browser runs sequential with desktop runtime verification or smoke testing, because they share `.next` and `.desktop-runtime`.

The shared-selector regressions exercise repeated trigger clicks and touch taps at desktop and compact widths, require dismissal without a value change or write, verify focus restoration and Enter/Escape handling, and confirm that keyboard selection still changes the value. The saved-model list regression verifies that descriptions are omitted from both lists but still match catalog searches. Catalog price checks cover USD per million tokens, free and missing prices, original non-token units, and desktop/compact layouts. `catalog-pricing.test.ts` verifies scale conversion, very small positive rates, malformed values and unknown billing units.

Media price regressions in `media-catalog-pricing.test.ts` cover image units/providers/variants, cent conversion, video-token scaling, minimum charges, unknown and invalid units, bounded trusted-host endpoint discovery and cancellation. `model-management.test.ts` checks upgrading old media snapshots, persistence, model addition and preserving prior quotes after endpoint failure. `media-pricing.spec.ts` verifies all price details, popup dismissal/focus, mobile overflow and usage drawer batches/filtering at desktop and 390px widths. `model-call-usage.spec.ts` verifies the drawer against real locally recorded calls and keeps unsaved model limits intact. Browser plugin unavailable; these checks use the repository’s Playwright harness.

`window-transitions.test.ts` checks deferred native actions, maximize coalescing, queued close priority, tray-compatible close guards, renderer failure/timeout and teardown cleanup. The caption-click acceptance check still exercises trusted native mouse input rather than synthetic DOM clicks. Native transition QA must also check minimize/restore, maximize/unmaximize, close-to-tray/reopen, quit and reduced motion in the real Electron window.

Browser acceptance follows the current disclosure controls: open recent conversations before paging/selecting them, select “自动化与通知” before checking scheduled history/reviews (including after reload), and open the model usage drawer before asserting recorded fallback charges. Conversation selectors distinguish the primary conversation button from its action menu; all persistence, ownership and billing assertions remain in place.

Template regressions verify default-title changes after template switching, persistence after reload/restart and preservation of independently named titles. Clipboard tests read the actual copied instructions, simulate a refused write and distinguish copying instructions from creating an editable template copy. Template editing opens in a keyboard-accessible sheet with collapsed retrieval settings and reduced-motion support. Compact conversation tests exercise row menus, tag-input focus, pin/archive/export actions, dark/light themes and 390px layouts. Execution-record tests check two-line previews, the complete stored goal on expansion and unchanged composer bounds. Screenshots stay in the system temporary directory. Browser plugin unavailable; these checks use the repository's Playwright harness.

Conversation status changes load immediately without a separate submit. Held-response browser tests verify that search/reset/status reads do not disable or repaint the search controls, and a delayed archived response cannot replace a newer all-conversations result. Archive/restore tests also switch statuses directly before and after service restart.

Official MCP Registry discovery is covered by `extension-registry.test.ts` and `extension-discovery.spec.ts`. Metadata requests are bounded to the fixed official host and do not probe listed services. Tests exercise exact-version details, compatibility labels, credentials withheld until explicitly configured, pagination/cache limits, malformed/removed metadata, cancellation, timeouts and local access/quotas. The isolated offline HTTP fixture serves official-shaped responses while allowing only the explicitly configured loopback MCP test server; unmatched network requests remain blocked. Browser acceptance follows discovery → details → connection draft → save inactive → detect → select tools → enable → chat approval, and verifies that browsing/saving alone executes no tools. Result-panel checks cover independent bounded scrolling, keyboard scrolling, one request per page while pending, preserved rows and scroll position after failure/retry, and reset on a new search. Dark/light, 390px layouts, focus transfer and reduced-motion screenshots remain in the temporary `ria-registry-qa` directory. No CI workflow or dependency change is needed: existing test globs discover these files. DSH bridge compatibility findings and their operational limits are documented in `extensions.md`; third-party services and package installation are not added to the deterministic CI suite.


## Community Skill marketplace

`tests/server/skill-marketplace.test.ts` covers search identity/source validation, fixed hosts and redirect policy, omitted credentials, bounded and cancellable streams, frontmatter, file paths and duplicate rejection, full snapshot retention, digest binding, inactive installation, local resource pagination, permission boundaries and disable/uninstall. `tests/e2e/skill-marketplace.spec.ts` exercises search, previewing references, installation, real chat tool execution against an offline model fixture, persistence across restart, empty/outage states, stale responses, narrow layouts, light/dark themes, focus return and reduced motion. Browser plugin not available; use the repository Playwright harness.

The offline HTTP fixture mocks only the public skills.sh search/download endpoints; CI does not install an external CLI, run skill scripts or depend on a live marketplace. Live read-only search/download checks are separate compatibility evidence, not model-quality or CI evidence. Existing test globs include the new files. The `yaml` runtime dependency and lockfile support bounded SKILL.md metadata parsing; no new CI service or environment secret is required.


## Knowledge library presentation

`tests/e2e/knowledge-layout.spec.ts` checks the compact document library, import preview/save, retrieval, expandable help and maintenance, long-entry disclosure, draft preservation after a failed create, focus return and narrow light/reduced-motion sheets. Existing knowledge-management, document structure, document retrieval, assistant evaluation and business-persistence suites retain their behavior assertions; create and batch-index workflows now explicitly open their sheet/disclosure. Screenshots are written outside the repository to the temporary `ria-knowledge-layout-qa` directory. The Browser plugin is unavailable; verification uses the existing Playwright harness. No schema, dependency or CI workflow change is required.


Knowledge entry presentation additionally has pure regression coverage in `tests/server/knowledge-entry-presentation.test.ts` for tool envelopes, multiline content, unsupported versions, duplicate/malformed fields and plain-note fallback. The tool-record case in `knowledge-layout.spec.ts` verifies compact previews, formatted excerpts without remote images, raw-record access, unchanged raw editing/search, multiline note expansion and dark/light narrow layouts.

## Provider search and execution details

Agent prompt regressions in `chat-lifecycle.test.ts`, `assistant-templates.test.ts`,
`document-rag.test.ts` and `provider-search.test.ts` inspect the actual model request
and reference formatting: task execution, human approval, relevant-only evidence,
empty context omission, configuration versus template restrictions, and explicit
updates of immutable template snapshots. They do not establish real-model response
quality. `chat-actions.spec.ts` measures the file-permissions entry before and after
execution activity appears at desktop and narrow widths. It also captures an actual
approval card with a simulated, unexecuted HTML-file command, checks its compact
default height and placement above the permission toolbar, hidden command content,
keyboard expansion/collapse, intermediate motion and reduced-motion behavior,
light/dark themes and visible approval controls at narrow widths. The execution
drawer remains closed until explicitly opened; full execution records remain the
source of detailed tool inputs, outputs, evidence and diagnostics.

`tests/server/provider-search.test.ts` checks the native DeepSeek, independent
Search API and OpenRouter gateway wire formats, provider priority without
Tavily, supported-endpoint fallback, refusal to bypass access/quota failures,
empty versus unexecuted searches, cancellation and usage accounting.
`execution-details.test.ts` verifies server-issued run identity, restored
metadata, authentication, cross-conversation rejection and template/configuration
reasons. Shared execution tests retain budget, approval and cancellation checks.

Terminal regressions execute a real file-operation workflow and discover a
temporary executable in custom paths containing spaces and Unicode. They change
PATH between approved commands and check missing-command failure. The portable
cases do not require Python, Go or Node to be preinstalled or use a fixed tool
version. Optional installed runtimes are probed separately. These are isolated
local scenarios, not proof of deployment on every Windows machine.

Browser regressions open **执行记录 → 详情** to check tool inputs/results, web and
document evidence, citation versions, deleted-source snapshots and diagnostics.
They retain inline-answer and downloadable-artifact checks and verify approval,
live terminal output, stop, restart recovery and narrow layouts. The Browser
plugin is unavailable; the repository Playwright harness provides verification.
Test globs already include the new files; no additional CI secret, service,
dependency or schema migration is required. Live search quality and account
access require separate real-service validation.

Terminal mode coverage in `tests/server/terminal.test.ts` verifies per-folder
approval decisions, repeated approval, changes within an existing toolset,
stale bindings, mode-change cancellation, invalid modes, resets on re-grant and
complete Unicode scripts exceeding Windows environment limits. Backup tests
verify full-access grants reset to approval on restore. Desktop migration tests
verify existing grants keep approval and repeated startup preserves user choices.
`tests/e2e/terminal.spec.ts` uses the offline model with real PowerShell to verify
automatic execution, live output and stop controls, mode persistence across a
service restart, mode changes through settings, approval of consecutive calls,
long-script approval continuation and saved results without re-execution.
Long-script fixtures exceed 2 MiB; browser tests measure the actual approval and
follow-up request bodies and verify later history requests complete without
re-executing commands. `tests/server/security.test.ts` verifies complete scripts
in approved/rejected continuations and history, with and without Content-Length,
and checks that only the chat route bypasses Proxy's body cloning. Other JSON
limits, local credentials, origin checks and JSON shape validation remain covered.
Desktop and narrow viewports use the repository Playwright harness because the
Browser plugin is not available. Existing CI globs include these tests; the
desktop migration chain carries the new default-approval column automatically.

Edited-file coverage in `tests/server/terminal-file-changes.test.ts` executes
real commands and checks created/modified/deleted files, same-size edits,
read-only calls, failed and stopped writes, ignored dependencies/junctions,
partial-observation semantics, multi-call merging and canonical file opening
after permission and existence changes. `tests/desktop/open-local-file.test.ts`
checks the native opener with an injected system-shell function, including
missing files and default-application errors; it does not launch another app.
The terminal browser suite verifies reply-end visibility, an approval pause,
persisted rows after restart, click-through to a mocked desktop bridge, deleted
files, lost permission and application-open failure/recovery. Its example images
come from real fixture file edits in the built service, with desktop and narrow
viewport captures outside the repository. Browser plugin not available; the
repository Playwright harness is used. Existing test globs and desktop packaging
include these files without a new dependency, service or schema migration.
