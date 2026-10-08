# Local integration API

Scheduled execution history, explicit retry and sanitized diagnostics are
documented in [execution history and recovery](execution-history.md).

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
| `GET /api/conversations/:id` | Conversation summary: ID, title, timestamps and message count; used by selection restoration |
| `GET /api/conversations/:id/messages/:messageId` | Message by persisted or client message ID; returns `data` with role, content, status and timestamps; retains private-media migration |
| `GET /api/tasks/:id` | Task detail, including title, details, due date, priority and status |
| `PATCH /api/tasks/:id` | Task update, including deadline, time zone, reminder and recurrence; returns `data` plus `nextTask` when completion creates a successor |
| `GET /api/memory?query=...&limit=5` | Relevant local memories; maximum 20, empty query returns an empty list |
| `POST /api/memory` | Upsert a local memory using `key` (1–120 characters), `value` (1–4000) and optional `score` (0–1); returns `201` with `data` |
| `POST /api/retrieval` | Retrieve local memories using JSON `query` (1–2000 characters) and optional `limit` (1–20, default 6); returns `data` |

The memory and retrieval endpoints remain deliberate local integration contracts even though the UI uses the knowledge page and tools. Missing or foreign detail records return `404`; unauthenticated requests return `401`. Mutations use the same bounded JSON parsing and same-origin checks as UI requests. Embedding configuration is optional; keyword retrieval remains available without a provider key.

Task schedule formats, recurrence rules and the desktop-only reminder claim endpoint are documented in [Task reminders](task-reminders.md). Claiming is a mutation with delivery consequences, so integrations must not poll it as a task-list endpoint.

Media browsing uses `GET /api/media/library` with filtered cursor pagination and `GET /api/media/:id/details` for stored provenance and generation parameters. `POST /api/media/:id/regenerate` requires explicit confirmation, reuses the stored recipe and creates a new asset without replacing history. See [Media library](media-library.md) for contracts, quotas, legacy limitations and input-reference protection. `GET /api/media` continues to return storage statistics.

## Retrieval behavior

Document imports now offer `POST /api/documents/preview` (multipart `file` and optional
`collection`), returning local extraction chunks, notes, `previewHash` and nullable
`base` without saving or calling a model. To confirm via `POST /api/documents`, send
the original file and collection plus `previewHash` and JSON-string `base` together.
The server verifies extraction and the current same-filename revision atomically;
concurrent changes return 409 and require a fresh preview. Direct imports without
these fields remain compatible. Unknown/duplicate upload fields and collection
names over 40 trimmed characters are rejected. Preview has a separate six-attempt
minute quota. Summaries add `lexicalCurrent`, `stale`, `differentModel` and `invalid`
inside `semantic`; only fresh valid vectors count as indexed. Bulk maintenance uses
the existing bounded embedding endpoint, with no background job or new write API.
See [Document knowledge](document-knowledge.md) for structure, limits and continuation.

Assistant template CRUD and conversation snapshot fields are documented in
[Assistant templates](assistant-templates.md). Preview retrieval retains its `data`
array and adds diagnostics; `POST /api/documents/evaluate` supports confirmed,
bounded retrieval/answer evaluation. Optional `judgeAnswers` adds structured
semantic review; `judgeModel` selects an allowed chat model, and per-case
`expectations` specify facts, conditions, exceptions, quantities or conflicts.
Judging requires generated answers and explicit paid-call confirmation; malformed
review results remain failures while preserving answers. See [Document knowledge](document-knowledge.md).

Queries use the runtime's Chinese word segmentation, Unicode compatibility normalization, duplicate removal and a small stop-word list. Word boundaries may vary with the runtime's ICU version. Ranking evaluates scores once and uses deterministic ordering for ties. Unrelated entries cannot rank solely because they are recent or manually weighted.

Memory search combines bounded recent and lexical candidate sets: up to 100 of each for context recall, and 50 of each for explicit knowledge search. Context retains tool memories and its recency/manual weights; explicit knowledge search excludes tool memories and merges built-in entries and imported document results. The first 16 query terms widen lexical candidate selection so older matching notes are not hidden solely by newer unrelated notes. Memory retrieval remains bounded keyword/embedding retrieval, not a guarantee of semantic recall.

Imported documents use local BM25 ranking plus optional semantic vectors in SQLite. Explicit indexing and queries against compatible vectors call the selected embedding provider and may incur costs; import/reindex remain local. See [Document knowledge](document-knowledge.md) for endpoints, confirmation, batching and limits. Knowledge-tool results preserve fused document ranking and adjacent evidence before filling remaining slots with confirmed memories and built-in entries. Each document result has `source: "document"` and a versioned `reference` containing document/chunk IDs, filename, excerpt, heading, retrieval method and optional PDF page. Chat streams include server-produced `metadata.documentSources`; persisted assistant messages retain these snapshots and actual citation-link status for history rendering. Source pages require the local workspace credential and do not provide public file URLs.

## Workspace activity reviews

`GET /api/activity/review?period=daily|weekly&timeZone=Asia%2FShanghai` previews
the previous complete calendar period in an IANA time zone. Both query fields
are required; invalid zones, unknown or repeated fields are rejected. The response
contains `data` with UTC `startAt`/`endAt` (start inclusive, end exclusive), local
`startDate`/`endDate`, canonical `timeZone`, `period` and `facts`: fixed event
counts, coverage boundary/completeness, up to 100 source events and the omitted
source count. Preview does not create a conversation or call a model. It can
perform event-retention cleanup under the workspace gate.

`GET /api/activity/events/:id` returns `data` with the retained event, current
source data (or `entity: null` if deleted), and a document viewer link when
applicable. Unknown or expired events return 404. It does not return a historical
copy of the source body. Both endpoints use normal authentication, ownership,
workspace gate and private/no-store responses. See [Workspace reviews](workspace-reviews.md)
for event semantics, coverage, immutable scheduled snapshots and backup rules.

Document searches accept optional exact collection names and return retrieval
method, matched terms and versioned citation snapshots. Bounded current-source
checks use `POST /api/documents/references`; see [Document knowledge](document-knowledge.md)
for status and validation rules. Historical excerpts remain unchanged when
current source text changes or is deleted.


Manual tool execution (`POST /api/tools/run`) accepts an absent model: local task creation, memory operations and deterministic retrieval must work with an empty model library. An explicitly supplied model still needs to be a library member. Manual execution does not require model tool-call capability because the user supplies the command; automatic chat tool calls retain capability checks and approval rules. Search answer synthesis may use the configured chat default, but a missing model or failed synthesis retains deterministic evidence. Manual synthesis receives the request cancellation signal and disables automatic provider retries.

Usage supports an optional `source` query (`chat`, `summary`, `scheduled`, `tool`, `embedding`, `media`, `unattributed`), rejecting invalid or duplicated parameters. Limits and current local-date allowance are returned with usage. A denied admission reports a conflict or configuration problem and submits no provider call; it does not fabricate a usage charge. See [Model settings and usage](model-usage.md).
