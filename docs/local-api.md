# Local integration API

These endpoints are supported for authenticated local integrations as well as the shared browser/Electron UI. They are not anonymous public services. All retain the Cookie, Host, Origin, ownership and error rules in [API security](api-security.md). A caller needs its own valid session; desktop automation must also use the current desktop session boundary. Never copy session secrets into scripts or documentation.

## Conversation and message pagination

`GET /api/conversations` returns 30 active conversations by default, pinned first and then ordered by newest last-message time. `GET /api/conversations/:id/messages` returns the newest 50 messages, ordered oldest to newest within that page. Both accept `limit` (1–100) and an opaque `cursor`, and return:

```json
{
  "data": [],
  "pageInfo": { "nextCursor": null, "hasMore": false }
}
```

For another page, send the returned `nextCursor` to the same endpoint. Append conversation pages; prepend older message pages. A null cursor ends traversal. Do not construct or reuse cursors across users or conversations. Invalid, duplicate or unknown pagination parameters return `400 VALIDATION_ERROR`; authorization runs first. Existing clients must follow `pageInfo` instead of assuming `data` contains all history.

Ordering uses timestamp plus ID, so equal timestamps are deterministic and deleting a cursor's original row does not break traversal. Conversation activity can move a row to the front between requests: refresh the first page to see new activity. This is a live list, not a frozen snapshot. Clients deduplicate IDs when merging pages.

The UI offers “加载更多会话” and “加载更早消息”. Reloading restores the selected active conversation by its detail endpoint even when it is outside the first page; archived selections are not restored into the sidebar. Stale page responses are ignored after switching conversations. Conversation details count messages without loading their bodies or migrating media; media migration runs only for messages actually read.

Conversation lists also accept `q`, `tag` and `state`. Cursors are scoped to those filters and use a new version: refresh old cursors after upgrading. See [Conversation management](conversation-management.md) for literal full-history search, organization, atomic confirmed bulk deletion and Markdown/JSON exports. Summary responses add `pinned`, `archived` and `tags`; default list reads exclude archived conversations.

Chat submissions send at most the latest 100 loaded messages. The existing server context window and incomplete historical excerpts remain in effect; loading older pages for display does not promise that all of them will be sent to a model. Regeneration checks only the target user message and subsequent affected history, preserves earlier messages, and still rejects concurrent changes to the affected range. Regenerating near the beginning of a long conversation can therefore inspect a large affected range.

## Supported detail and memory endpoints

| Endpoint | Supported behavior |
| --- | --- |
| `GET /api/conversations/:id` | Owned conversation summary: ID, title, timestamps and message count; used by selection restoration |
| `GET /api/conversations/:id/messages/:messageId` | Owned message by persisted or client message ID; returns `data` with role, content, status and timestamps; retains private-media migration |
| `GET /api/tasks/:id` | Owned task detail, including title, details, due date, priority and status |
| `PATCH /api/tasks/:id` | Owned task update, including deadline, time zone, reminder and recurrence; returns `data` plus `nextTask` when completion creates a successor |
| `GET /api/memory?query=...&limit=5` | Relevant memories for the current user; maximum 20, empty query returns an empty list |
| `POST /api/memory` | Upsert the current user's memory using `key` (1–120 characters), `value` (1–4000) and optional `score` (0–1); returns `201` with `data` |
| `POST /api/retrieval` | Retrieve current-user memories using JSON `query` (1–2000 characters) and optional `limit` (1–20, default 6); returns `data` |

The memory and retrieval endpoints remain deliberate local integration contracts even though the UI uses the knowledge page and tools. Missing or foreign detail records return `404`; unauthenticated requests return `401`. Mutations use the same bounded JSON parsing and same-origin checks as UI requests. Embedding configuration is optional; keyword retrieval remains available without a provider key.

Task schedule formats, recurrence rules and the desktop-only reminder claim endpoint are documented in [Task reminders](task-reminders.md). Claiming is a mutation with delivery consequences, so integrations must not poll it as a task-list endpoint.

Media browsing uses `GET /api/media/library` with filtered cursor pagination and `GET /api/media/:id/details` for owned provenance and generation parameters. `POST /api/media/:id/regenerate` requires explicit confirmation, reuses the stored recipe and creates a new asset without replacing history. See [Media library](media-library.md) for contracts, quotas, legacy limitations and input-reference protection. `GET /api/media` continues to return storage statistics.

## Retrieval behavior

Queries use the runtime's Chinese word segmentation, Unicode compatibility normalization, duplicate removal and a small stop-word list. Word boundaries may vary with the runtime's ICU version. Ranking evaluates scores once and uses deterministic ordering for ties. Unrelated entries cannot rank solely because they are recent or manually weighted.

Memory search combines bounded recent and lexical candidate sets: up to 100 of each for context recall, and 50 of each for explicit knowledge search. Context retains tool memories and its recency/manual weights; explicit knowledge search excludes tool memories and merges built-in entries and imported document results. The first 16 query terms widen lexical candidate selection so older matching notes are not hidden solely by newer unrelated notes. Memory retrieval remains bounded keyword/embedding retrieval, not a guarantee of semantic recall.

Imported documents use a separate local inverted index without embedding calls. See [Document knowledge](document-knowledge.md) for import/reindex/delete/search endpoints and limits. Knowledge-tool document results add `source: "document"` and a `reference` containing document/chunk IDs, filename, excerpt and optional PDF page. Chat streams also include server-produced `metadata.documentSources`; persisted assistant messages retain these snapshots for history rendering. Sources are authorized by their stored owner when opened, and do not provide public file URLs.
