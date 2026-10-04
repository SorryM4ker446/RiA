# Conversation management

Open **管理会话** from the chat sidebar. Browser and Electron share the same page and authenticated APIs. No search service, model key or paid API call is needed.

## Organizing history

- Search matches literal fragments in conversation titles and all stored message text, including older messages outside the loaded chat page. Enter 2–200 characters and submit **搜索 / 筛选**. Search returns conversations, not individual message locations; use **加载更早消息** to read older history after opening one.
- Pinned conversations appear first, followed by last-message time and ID. Metadata edits do not change the last-message time.
- Tags are normalized with Unicode NFKC, trimmed and lowercased. Each conversation supports eight tags of up to 32 characters. Commas/control characters are invalid; duplicate normalized tags collapse into one. Tag filtering matches a complete tag.
- Archived conversations disappear from the default sidebar and can be searched with **已归档** or **全部**. **恢复并打开** makes one active again. Archiving does not delete messages or revoke API access. It does not make a conversation read-only or stop its independent tasks/reminders.
- Select up to 50 loaded conversations to delete. The confirmation dialog lists exactly those titles. Changing filters or refreshing clears selection. Deletion is irreversible; an invalid, missing or foreign ID rejects the entire batch without deleting any conversation. Shared media references are retained, and unreferenced files still require the separate storage-cleanup confirmation.

The manager loads 30 conversations at a time. Pinning, archiving and new messages can move rows between requests, so refresh to see concurrent changes. A loaded page is not a frozen snapshot; changes from another browser window are not pushed live.

## Text exports

Each conversation offers **导出 Markdown** and **导出 JSON**. Downloads include all messages in chronological order, status, organization fields, retained document citation excerpts, and private-media references. They do not include raw tool inputs/outputs, approval tokens, local media paths, provider settings or media bytes. Markdown renders message bodies as literal fenced text to keep untrusted message markup inactive. JSON uses `formatVersion: 1`.

Exports are text snapshots, not restorable backups. Private references such as `/api/media/:id` still require the original application and authorized user; they are not portable public download links. Unavailable or legacy embedded media is omitted and marked. Export does not migrate legacy media or modify messages. Message text and citation excerpts may themselves contain information supplied by the user or model; exports are **not** a secret-redaction service. Treat downloaded files as private, even though configuration credentials are not collected.

One export allows at most 5,000 messages, 32 MiB of stored source content and 16 MiB of serialized output. Larger exports return `413 PAYLOAD_TOO_LARGE` without a partial file. There is no streaming/archive backup mode. Downloaded files are outside the application's managed-media cleanup.

## API contract

All operations require normal ownership/session and desktop Host/Cookie checks. See [API security](api-security.md).

| Endpoint | Input and response |
| --- | --- |
| `GET /api/conversations` | Optional `q`, `tag`, `state=active\|archived\|all`, `limit=1..100` and opaque `cursor`; defaults to active, 30 rows; returns `data` and `pageInfo` |
| `GET /api/conversations/:id` | Summary with `pinned`, `archived`, `tags`, timestamps and `messageCount` |
| `PATCH /api/conversations/:id` | At least one of `title`, boolean `pinned`, boolean `archived`, or string-array `tags`; returns updated `data`; title keeps the existing 60-character display truncation |
| `POST /api/conversations/bulk-delete` | `{ "ids": ["chat-id"], "confirm": true }`; 1–50 unique IDs, 16 KiB body; returns `data.deletedCount` |
| `GET /api/conversations/:id/export?format=markdown` | `markdown` (default) or `json`; attachment response with safe filename, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` |

Unknown/duplicate query parameters and invalid fields return the shared error envelope. Search, export and bulk-delete have separate per-instance quotas of 30, 6 and 10 requests per minute. Default list reads are not charged as searches. Cursor scope includes user, query, tag and archive state. Refresh after upgrading from older cursors or changing filters; never reuse one across scopes.

## SQLite migration and maintenance

The SQL migration adds organization fields, tag relations, and SQLite FTS5 trigram tables for titles and message text. It backfills existing records and uses triggers for inserts, edits, regeneration and deletion cascades. Stable application IDs connect the index to records even after SQLite `VACUUM`; ID tokens are used internally for efficient index maintenance, not searched by the conversation API. Known structured message formats contribute only their text, excluding media payloads and tool internals. Malformed structured messages remain stored but contribute no search text.

Queries of three or more Unicode characters use case-insensitive trigram matching. Two-character queries use a literal scan fallback (SQLite's built-in lowercase folding covers ASCII). This is substring search, not semantic retrieval, token ranking or accent/Unicode normalization of message text. Very large histories and two-character scans can be slower. No large-corpus performance guarantee is implied by functional tests.

FTS tables/triggers are intentionally managed by SQL migrations, outside the Prisma schema models. Keep them when reviewing generated migrations or introspection changes. Indexes duplicate searchable text inside the private database and increase its size; they contain the same private message content as the source records. Do not copy them to a public directory.

Desktop startup backs up an existing database before applying pending migrations. Local Web migration commands do not create that backup automatically: back up an existing database before migration. Automatic tests use isolated databases, media and download directories. They verify legacy backfill, punctuation/Chinese search, archive restoration, atomic deletion, export boundaries, authenticated browser downloads and actual Electron downloads after a service restart. Installer upgrade/uninstall/reinstall acceptance remains a separate release check.

## Unsent drafts

What is typed into the composer is kept per conversation. Switching conversations, switching pages, reloading or restarting the application all return it to the same conversation.

Attachments are uploaded when they are chosen, and the draft keeps the reference the server returned rather than the file: a file cannot be handed back after a reload, a reference can, so a draft is still sendable after a restart. An uploaded attachment that is never sent becomes an unreferenced file, which the media store's existing grace-period cleanup reclaims — an abandoned draft costs disk for a while and nothing more.

A draft is cleared only once the turn actually produced an answer. A send that fails puts the text back so it can be retried. Stopping does not: the question was delivered and is in the conversation, and putting it back would invite sending it twice.

## Stopping a turn

While a turn is running, the send control is replaced by **stop**. Stopping abandons the request, not the question: whatever the model produced stays on screen and is stored as an interrupted answer. It does not mean the provider stopped billing.

## Keyboard and copying

- **Enter** sends, **Shift+Enter** adds a line; an Enter that is part of an input-method composition does not send.
- **Escape** closes a delete confirmation; with none open, it stops a running turn.
- Every answer has a **copy** control, and a code block has its own **copy code** control that appears on hover or focus — selecting text across a scrollable code box is a poor substitute. When the clipboard is unavailable the answer is not interrupted and the text stays selectable.

## Following the scroll

New messages are followed while the reader is already at the bottom, and are ignored once they have scrolled up, where a **jump to latest** control appears. The decision is made by measuring the position at the moment content arrives rather than from a remembered scroll event: a scroll that has not been delivered yet would otherwise read as "still following" and pull the view down in the middle of an answer.

## Summary invalidation

Editing, deleting, replacing a persisted answer or successfully regenerating
history clears the stored compression and increments its history revision in the
same transaction. Summaries are built from stored message content rather than a
stale browser transcript. Stored messages use the existing readable historical
representation, without replaying approval metadata, reasoning or attachment bytes.
A model result is saved only if the history revision
still matches; a slower result cannot restore obsolete decisions after an edit.
A missing covered message causes fallback to existing bounded history excerpts.
Cached summaries are reused only when both revision and covered identity match.

The additive migration drops earlier unverifiable summaries while preserving all
original messages. Desktop startup snapshots existing data before this migration.
Versioned summaries survive portable restore with remapped message identities;
legacy or inconsistent summary evidence is discarded and can be recomputed later.
This is compression invalidation, not deletion of the conversation history.
