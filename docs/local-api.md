# Local integration API

RiA package preview, skills.sh search/details, installation and lifecycle endpoints under `/api/plugins`
are documented in [Plugin packages](plugin-packages.md#persistence-and-api).

Local document parsing, draft conversion and version-bound downloads are described
in [Document processing and export](document-processor.md#local-api).

External tool discovery, connection configuration and activation are documented
in [Extensions](extensions.md#local-management-api), including official Registry
search and exact-version details under `/api/extensions/registry`. These endpoints use the same
local authentication and restore gates; tool calls still require chat approval.

Task runs, their history and sanitized diagnostics are documented in
[Tasks](tasks.md#api) and [execution history and recovery](execution-history.md).

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

The recent-conversations list reveals further rows, and then requests the next page, only as it is scrolled to its end; the transcript offers “Load earlier messages”. Reloading restores the selected active conversation by its detail endpoint even when it is outside the first page; archived selections are not restored into the sidebar. Stale page responses are ignored after switching conversations. Conversation details count messages without loading their bodies or migrating media; media migration runs only for messages actually read.

Conversation lists also accept `q`, `tag` and `state`. Cursors are scoped to those filters and use a new version: refresh old cursors after upgrading. See [Conversation management](conversation-management.md) for literal full-history search, organization, atomic confirmed bulk deletion and Markdown/JSON exports. Summary responses add `pinned`, `archived` and `tags`; default list reads exclude archived conversations.

Chat submissions send at most the latest 100 loaded messages. The server reads the stored turns before them, so a conversation reopened with only its latest page loaded keeps its earlier context: from the last message the current summary covers, or from the start when there is none. The browser's messages remain authoritative for the turns it sends. The server context window, summary and excerpts then decide what reaches the model, independent of how many pages are loaded for display. Regeneration checks only the target user message and subsequent affected history, preserves earlier messages, and still rejects concurrent changes to the affected range. Regenerating near the beginning of a long conversation can therefore inspect a large affected range.

## Supported detail and memory endpoints

| Endpoint | Supported behavior |
| --- | --- |
| `GET /api/conversations/:id` | Conversation summary: ID, title, timestamps and message count; used by selection restoration |
| `GET /api/conversations/:id/summary` | The summary standing in for earlier turns, as `data` with `summary` and `coveredIds` (identities of the message it ends after, empty when it ends at none); `data` is `null` when there is none, including for an unknown conversation |
| `GET /api/conversations/:id/messages/:messageId` | Message by persisted or client message ID; returns `data` with role, content, status and timestamps; retains private-media migration |
| `GET /api/conversations/:id/runs?runId=...` | Persisted assistant message associated with a server-issued run ID, or `null` when unavailable; verifies run ownership in this conversation and uses private/no-store caching |
| `GET /api/conversations/:id/runs?limit=...` | Execution summaries with optional `messageId` (client message ID when available) for grouping approval continuations; steps include saved bounded `input`/`output` summaries |
| `GET /api/memory?query=...&limit=5` | Relevant knowledge entries (the path keeps its older name); maximum 20, empty query returns an empty list |
| `POST /api/memory` | Upsert a knowledge entry using `key` (1–120 characters), `value` (1–4000) and optional `score` (0–1); returns `201` with `data` |
| `GET /api/memory/document` | MEMORY.md as `data` with `content`, `revision`, `updatedAt`, the notes sorted into `topics`, those not yet sorted in `unsorted`, and whether sorting is `settled` or `organizing` |
| `PATCH /api/memory/document` | Rewords a note, with `revision`, `line` and `text` (1–500 characters); a revision that is out of date returns `409` |
| `POST /api/memory/document` | Sorts the notes into topics in the background if they need it, using the model; returns the same `data` as `GET` |
| `DELETE /api/memory/document?revision=...&lines=1,2` | Deletes those notes, or everything when `lines` is left out; a revision that is out of date returns `409` |
| `POST /api/retrieval` | Retrieve local memories using JSON `query` (1–2000 characters) and optional `limit` (1–20, default 6); returns `data` |

The memory and retrieval endpoints remain deliberate local integration contracts even though the UI uses the knowledge page and tools. Missing or foreign detail records return `404`; unauthenticated requests return `401`. Mutations use the same bounded JSON parsing and same-origin checks as UI requests. Embedding configuration is optional; keyword retrieval remains available without a provider key.

File actions are offered through `runTerminalCommand`, `readProjectFile` and
`editProjectFile` in any granted folder. Whether an edit or command waits for
approval is the conversation's approval rule (`approvalRule` on
`PATCH /api/conversations/:id`: `ask`, `acceptEdits` or `full`); a task's
conversation follows the task's. `GET`/`PUT /api/approval-preferences` reads and
sets `{ defaultRule }`, the rule new conversations start with. There is no
`PATCH /api/directory-grants/:id`: a folder has no terminal switch. Completed replies can show observed
file changes from terminal results and exact edits.
`POST /api/terminal/files/resolve` accepts `{ grantId, path }` and resolves an
existing regular file inside a currently granted folder; the desktop
bridge opens the returned canonical path after a user click. See [Terminal
tools](terminal-tools.md) for observation scope and partial results.
Retired `listLocalFiles`, `readLocalFile`
and `writeLocalFile` IDs are no longer executable catalog entries. Legacy template
selections normalize to the terminal without enabling folder permission. Old
transcripts remain readable; old file-tool approvals cannot execute after upgrade.

Task endpoints, schedule formats and the desktop-only notification claim are documented in [Tasks](tasks.md#api). Claiming is a mutation with delivery consequences, so integrations must not poll it as a task-list endpoint.

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

Entry search compares every confirmed knowledge entry, by keyword and, where a compatible vector exists, by meaning. Nothing is added to a chat request on its own: the model reaches entries and documents through `searchKnowledge`, which merges both. This is keyword/embedding retrieval, not a guarantee of semantic recall.

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


`POST /api/tools/run` runs only tools that finish without a model, currently `convertDocument` and `compactContext`. The second folds a conversation's turns before its latest exchange into its summary: it takes an optional `focus` and the `chatId`, and returns `status` (`compacted` or `nothing`) and an estimate of `freedTokens`. Any other tool returns a validation error and goes through the conversation, where the model has the context to fill in its input and use its result.

Normal chat offers all available tools allowed by the current assistant to a
tool-capable model. The retired `manualToolsOnly` boolean remains accepted by
`POST /api/chat` for older clients but is ignored; it cannot disable automatic
tools. A user message may carry `metadata.invocation`, what the person chose in the
composer's slash menu: at most one tool and any number of skills. The server checks
the choice against the assistant's allowlist, the model's tool support and current
availability, and refuses the message when it cannot be honoured. A chosen tool is
the only one offered on the turn's first step, and every allowed tool is offered
after that; a chosen skill's instructions travel with the message. An approval
resume does not repeat the choice. When the model answers without calling the chosen
tool, the saved answer records it as `skippedTool`. The choice never changes the
assistant's tool allowlist or bypasses external-tool approval.

A conversation with older turns and no summary yet starts its response before the
answer: the stream opens with a transient `data-context-status` part, `{ organizing: true }`,
then `{ organizing: false }` once the answer can start. A refusal after that point
arrives as a stream error rather than an HTTP status.

`GET /api/tools` lists the registered tools, with `surface` stating who can
call each; one with `underlying` set to `application` is never offered to the model, and one set to `model` is for the model alone. It also returns the `toolCalling` entry for the model's ability to call tools at all and
the enabled `skills`.

Usage supports an optional `source` query (`chat`, `summary`, `scheduled`, `tool`, `embedding`, `media`, `unattributed`), rejecting invalid or duplicated parameters. Limits and current local-date allowance are returned with usage. A denied admission reports a conflict or configuration problem and submits no provider call; it does not fabricate a usage charge. See [Model settings and usage](model-usage.md).

