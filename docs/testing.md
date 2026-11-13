# Testing

How the tests are organised, how to run them, and the rules that keep them reliable. What an individual test checks is said in the test itself (its name and comments); this page does not repeat it. For investigating a GitHub Actions run, see [Validating changes against GitHub Actions](ci-validation.md).

## The suites

| Command | What it runs | Against |
| --- | --- | --- |
| `npm run test:server` | `tests/server/*.test.ts` — route handlers, persistence, the model and tool layers, scheduling, retrieval, security boundaries, and client-side modules that do not need a browser | Real Next.js handlers called with `NextRequest`, a temporary SQLite database per file, deterministic model doubles; no network |
| `npm run test:e2e` | `tests/e2e/*.spec.ts` — the application in Chromium, end to end | A production build served by the standalone server, an isolated database per run, offline model responses |
| `npm run test:desktop` | `tests/desktop/*.test.ts` — the Electron main process's parts, desktop migrations, packaging and installer checks | Node's test runner and SQLite; Electron where a test needs it |
| `npm run test:desktop:smoke` | The real Electron window against the prepared standalone runtime: start-up, the page bridge, authentication, persistence across service restarts, backups, media, documents, notifications. `-- --maximized` starts the window maximised | The packaged-style runtime in an isolated profile; no model calls |
| `npm run test:desktop:dev` | The same smoke run against `next dev` | Slow on first compile; it can exceed the smoke run's two-minute limit on a busy machine, which is not a failure of the code |
| `npm run test:db` | Desktop migrations and local-database verification | A temporary database unless `LOCAL_DATABASE_FILE` names one |
| `npm run test:e2e:diagnostics` | Fails one nested browser test on purpose and checks that its trace, screenshot, reports and server log are kept | The isolated HTTP fixture |
| `npm run typecheck` | Application code (strict `tsconfig.json`) and tests (`tests/tsconfig.json`, which extends it) | — |
| `npm run lint` | ESLint over the repository | — |

Three more suites run only on demand, never in an ordinary or CI run:

| Command | What it does |
| --- | --- |
| `npm run test:visual` / `test:visual:update` | Compares (or records) screenshots of the main pages, at two widths, in both themes and both languages, against the git-ignored `.visual-baseline/`. Machine-specific: record before an interface change, compare after it. |
| `npm run test:perf` | Measures switching between long conversations, typing delay and opening the command palette, and prints the numbers with main-thread long tasks. Only a gross regression fails it. |
| `npm run test:real` | Scenarios against a real model provider; they cost money. See [Real model scenarios](#real-model-scenarios). |

Before accepting a change, run lint, the type check, the server suite, the browser suite and a production build. When the database schema changes, regenerate Prisma first (`npm run db:generate`) and run the desktop suite too. After a dependency change, check a clean install (`npm ci`) from the committed lockfile: a working `node_modules` does not show that the lockfile installs.

## How each layer works

**Server tests** call the application's own route handlers; no HTTP server runs. Each file creates and removes its own SQLite database. Model calls go to deterministic doubles, and the `offline-http.ts` preload refuses any outbound `fetch` that a test has not matched. The TypeScript loader (`tests/helpers/register-typescript.ts`) resolves `@/` imports and maps `next/server` and `next/headers` to their entry points; it must not call `require.resolve()` inside its resolve hook, which re-enters the hook on newer Node versions. The application has no test switch of its own.

**Browser tests** build the application, prepare `.desktop-runtime` and start the standalone server once per run. Each run gets its own `.desktop-data/test/e2e-<UUID>/` (database, media, storage state), an OS-chosen loopback port, and a pinned test-only access cookie installed by the global setup. Tests that need their own service (restarts, a clean database, real HTTP all the way down) start one with `startStandaloneServer` from `tests/helpers/standalone-server.ts`, which owns a directory under `.desktop-data/test/http-*` and removes only that. Provider keys are blank and model responses come from the offline fixture (`configureOfflineModels`). Tags select subsets: `-- --grep "@integration"` runs the flows that go through real HTTP and SQLite; `--repeat-each=3` checks a test repeats cleanly.

**Desktop tests** exercise the Electron main process's modules directly and migrate copies of real schemas. The smoke runs drive a real window through `electron/smoke-run.ts`, with Electron's userData, SQLite and media all in an isolated `.desktop-data/test/electron-smoke-*` profile; a failure keeps that profile and its logs. Electron must already be installed: the smoke run never downloads it.

**Ordering.** Builds, browser runs and smoke runs share `.next` and `.desktop-runtime`, so run them one after another, never side by side, and never run `next dev` and `next build` against the same `.next` at once.

## Continuous integration

CI runs static and database checks, three server-test shards and three browser shards as separate jobs, then the desktop packaging and smoke job. A server shard is reproduced locally with:

```bash
node --import ./tests/helpers/register-typescript.ts --test --test-concurrency=2 --test-shard=1/3 tests/server/*.test.ts
```

Run shards 1 to 3 for the whole suite; one shard is not a full pass. Browser jobs use two workers, no retries and the same timeouts as local runs. A local pass is not a hosted result: report the two separately, and see [ci-validation.md](ci-validation.md) for matching CI's Node, npm and environment.

## Writing reliable tests

- **Wait for the state, not for time.** Wait on a request completing, a row being saved or an element's state; hold a response with a gate when a test needs an intermediate state. No fixed sleeps, no retries, no longer timeouts to make a test pass.
- **Chat pages keep a server-sent event connection open**, so Playwright's `networkidle` never arrives on them. Use `watchNetwork(page).settled()` from `tests/helpers/network.ts`, and leave the page (`about:blank`) before restarting a service.
- **Seed a database only while its service is stopped**, so the test does not race the live scheduler's transactions.
- **Synthetic data only.** No real keys, documents or user data in fixtures; outbound requests are denied unless a test matches them.
- **Keep scratch output in the run's own directory.** On Windows the system temporary directory may be on a nearly full drive; this repository keeps test output under `.desktop-data/`.
- **Failures keep their evidence.** Browser runs use zero retries and keep the first failure's trace, screenshot and server log under `test-results/e2e-<UUID>/`, with the HTML report under `playwright-report/e2e-<UUID>/`.
- **Name a test by the behaviour it guarantees**, so a failure says what broke.

## Where things are covered

| Area | Server | Browser | Desktop |
| --- | --- | --- | --- |
| Conversations, messages, history | `crud`, `chat-lifecycle`, `chat-message-persistence`, `history-integrity`, `pagination`, `conversation-*` | `conversations`, `chat-lifecycle`, `chat-pagination`, `chat-startup`, `first-conversation`, `sidebar-conversations` | `conversation-migration` |
| Answers held by the service, parallel conversations, queueing | `live-turns`, `stream-backlog`, `conversation-session`, `model-call-controls` | `parallel-conversations` | `conversation-alerts` |
| Chat page behaviour | `chat-client`, `chat-modules`, `composer-invocation`, `ui-fixes` | `chat-actions`, `composer-tools`, `message-navigation`, `thinking`, `stream-responsiveness`, `interaction-*` | — |
| Context, compaction, memory | `context*`, `background-compaction`, `memory-lifecycle`, `prompt-*` | `context-organizing`, `memory-document` | `summary-migration` |
| Tools, terminal, approvals | `tool-*`, `terminal*`, `approval-rules`, `run-steps`, `agent-budget` | `terminal`, `tool-execution`, `execution-*`, `chat-permissions` | `terminal-migration` |
| Documents and knowledge | `document*`, `knowledge-*`, `retrieval-diagnostics` | `document*`, `knowledge-*` | `document-*-migration` |
| Tasks and scheduling | `tasks`, `scheduler-fixes` | `tasks-ui` | `task-*` |
| Models, providers, usage | `model-*`, `providers-fixes`, `deepseek-*`, `openrouter-*`, `catalog-pricing` | `model-*`, `account-settings` | `model-usage-migration` |
| Media | `media*` | `media-*` | `media-library-migration` |
| Extensions, plugins, skills | `extension*`, `plugin-packages`, `skill-marketplace` | `extension*`, `plugin-packages`, `skill-marketplace` | `extension-migration`, `plugin-migration` |
| Backups and upgrades | `backups`, `backup-fixes`, `local-workspace-*` | `account-settings` | `*-migration`, `updater`, `windows-installer`, `release-*` |
| Security and access | `security`, `access-fixes`, `local-entry`, `directory-grants` | `auth-security`, `server-diagnostics` | `bundle-boundary`, `service-environment` |
| Interface, motion, language | `motion-tokens`, `locale`, `tooltip-placement` | `ui-transitions`, `settings-*`, `title-bar-layout`, `sidebar-*`, `i18n`, `keyboard` | `window-*`, `startup-*`, `workspace-transparency` |

## Real model scenarios

`npm run test:real` runs the `@real` scenarios against a real provider. Nothing about a provider is kept in the repository: each run names the provider and model and gives a key, read from `RIA_REAL_API_KEY` when set and otherwise asked for without being shown.

```bash
npm run test:real -- --provider deepseek --model deepseek-flash --max-usd 0.05
```

Each scenario starts its own service with a temporary database, the key in that service's environment only, and the model added to its library and chosen for chat (`tests/helpers/real-model.ts`). What a scenario spent is read from the application's usage records, printed and attached to the report; once the run passes `--max-usd` (default $0.05), the remaining scenarios are skipped. Timings are printed, not judged. `real-conversations.spec.ts` switches between four conversations answering at once, then reloads and stops an answer mid-way and asks a follow-up.

## What tests do not cover

Real installation, upgrade and uninstall on a Windows machine, physical sleep and wake, native notification display, maximum-size archives, disk-full and power-loss behaviour, and live provider availability and billing are checked by hand: see [Windows release acceptance](windows-release-acceptance.md).
