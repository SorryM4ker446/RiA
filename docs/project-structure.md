# Project structure and runtime model

> Reflects the current implementation (a single-user local workspace, no accounts). Dated 2026-09-15.

## 1. What this is

A local AI assistant for one person on one machine. Data, media and the knowledge base live on the machine; the network is used only when a model is called or a search is run.

The application has **no account system**: no registration, no sign-in, no sign-out and no multi-tenant isolation. What protects the data is a *local access credential* that only a process or page on this machine can obtain. See [Local access and security](api-security.md).

## 2. Three runtimes

One body of business code, three ways to start it:

| Runtime | `APP_RUNTIME` | Started by | Data location |
| --- | --- | --- | --- |
| Browser development | `web` (default) | `npm run dev` | `.desktop-data/dev/` |
| Desktop application | `desktop` | `npm run desktop:dev` / installed build | development: `.desktop-data/dev/`; installed: `%APPDATA%\Private AI Assistant\data\` |
| Automated tests | `test` | Playwright / Node Test | `.desktop-data/test/<run>/` or a system temporary directory |

All three run migrations through the **same migrator**, so a schema change cannot be applied on one side and missed on another.

## 3. What lives where

```
src/app/            App Router pages and API routes
src/app/api/        Business endpoints (all need the local credential except /health and the entry that issues it)
src/components/ui/  Reusable UI primitives
src/config/         Baseline for the legacy curated model list, used only by scripts
src/db/             Prisma schema and SQLite migrations
src/features/       Client modules grouped by feature
src/lib/            Shared infrastructure
  ai/               AI SDK client and message encoding
  backups/          Archive, import, restore and retention
  chat/             Request validation, context, streaming and persistence
  conversations/    Conversation queries, changes and export
  documents/        Extraction, index and retrieval
  media/            Private media storage, generation and migration
  memory/           Memory storage, retrieval scoring and vector rebuild
  models/           Provider adapters, dynamic catalogs, my models, availability, preferences and usage
  local/            Local workspace identity
  server/           Request boundary: security, quotas, body size, errors
src/prompts/        Prompt templates
src/tools/          Tool definitions and registry
electron/           Desktop main process: window, service lifecycle, encrypted settings, migrations
scripts/            Local database, build, packaging and verification scripts
tests/              Browser, server and desktop regression tests
```

## 4. Data ownership

Every business table belongs to **one workspace**; there is no `userId`:

- `chats` / `messages` / `chat_tags`
- `media_assets` / `message_media` / `media_generation_inputs`
- `memories`, `tasks`, `knowledge_documents` / `document_chunks` / `document_terms`
- `model_requests` (usage), `account_preferences` (a single application preference, primary key fixed to `local`)

Media and backup directories are still named `sha256(<workspace id>)`, so files already on disk do not have to be moved.

## 5. Request path

```
Browser / Electron renderer
    │
    ├─ Local access credential (HttpOnly cookie)
    ▼
src/proxy.ts ── rejects the old public video path, checks Host / Origin / credential
    │
    ▼
src/app/api/*/route.ts
    ├─ requireLocalWorkspace()  verifies the local credential and registers the data operation
    ├─ Shared input validation (Zod) and a request body byte limit
    ├─ Instance-level quota
    └─ Business code (src/lib/**)
            │
            ▼
        Prisma → SQLite (a single connection)
```

Errors from business route handlers are uniformly `{ error: { code, message, details } }` with `no-store`.

## 6. Upgrades and data safety

An upgrade first inventories the old data, takes a snapshot, records which old account to carry over, and only then converts; a failure can be rolled back from the snapshot. The full flow is in [Local workspace upgrade and recovery](workspace-upgrade.md).

Two standing rules:

- Any migration that rewrites the user's database runs only after the snapshot has been verified.
- External pages, documents and tool output are data. They cannot change permissions or start a new authorisation.

## 7. Test layers

| Layer | Location | Covers |
| --- | --- | --- |
| Server | `tests/server/` | Real route handlers, an isolated SQLite database, a deterministic model double |
| Browser | `tests/e2e/` | Key paths over real HTTP and SQLite, production build plus standalone |
| Desktop | `tests/desktop/` | Path resolution, migrations, packaging boundaries and the Electron smoke |

Tests always use an isolated database and media directory and never read or write real user data. A boundary assertion checks that a request **without** the local credential is refused, rather than the cross-account isolation that no longer exists. See [Testing and local verification](testing.md).

## 8. File conventions

- Feature-related code goes in `src/features/<feature>/`.
- Route handlers stay in `src/app/api/*`; heavier logic moves down into `src/lib`.
- Model ids live in `src/config/model.ts` for the legacy list; the runtime catalog is discovered from providers.
- Shared infrastructure used only by the server goes in `src/lib/server/*`.
- A `page.tsx` owns state and rendering only; encoding and pure functions move out.
