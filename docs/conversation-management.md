# Conversation management

Open the management page with **Manage all conversations** below the conversations in the sidebar, or from the command palette. Browser and Electron share the same page and authenticated APIs. No search service, model key or paid API call is needed.

The management page uses compact rows and an inline search/filter bar. Changing **Conversation status** immediately applies the visible filters and loads that status; text and tag searches can also be submitted with **Search**. Click a conversation title to open it; pinning remains beside the title. Each row's **More actions** menu contains archive/restore, tag editing and Markdown/JSON export. Selection, the 50-item bulk-delete limit and explicit deletion confirmation are unchanged. Menus retain keyboard dismissal and focus restoration; tag editing focuses its input.

## Organizing history

- Search matches literal fragments in conversation titles and all stored message text, including older messages outside the loaded chat page. Enter 2–200 characters and submit **Search**. Search returns conversations, not individual message locations; use **Load earlier messages** to read older history after opening one.
- Pinned conversations appear first, followed by last-message time and ID. Metadata edits do not change the last-message time.
- Tags are normalized with Unicode NFKC, trimmed and lowercased. Each conversation supports eight tags of up to 32 characters. Commas/control characters are invalid; duplicate normalized tags collapse into one. Tag filtering matches a complete tag.
- Archived conversations disappear from the sidebar and the default list and can be searched with **Archived** or **All**. **Restore and open** makes one active again. Archiving does not delete messages or revoke API access. It does not make a conversation read-only or stop its independent tasks/reminders.
- Select up to 50 loaded conversations to delete. The confirmation dialog lists exactly those titles. Changing filters or refreshing clears selection. Deletion is irreversible; an invalid, missing or foreign ID rejects the entire batch without deleting any conversation. Shared media references are retained, and unreferenced files still require the separate storage-cleanup confirmation.

The manager loads 30 conversations at a time. Pinning, archiving and new messages can move rows between requests, so refresh to see concurrent changes. A loaded page is not a frozen snapshot; changes from another browser window are not pushed live.

## In-conversation navigation

The transcript's left edge provides a compact question locator when two or more
messages including a question are loaded. Each mark represents one user question.
The current mark is longer and follows the reader's position. Hover or focus a mark to preview the question,
then click or press Enter to scroll there without focusing or outlining the
message. Arrow keys move between marks; Home/End select the first/last loaded mark.
Transparent previews fade and slide on hover. Reduced-motion preferences disable
these transitions and animated jumps.
During a smooth jump, the target stays selected instead of highlighting each
question passed along the way. Scrolling manually releases that selection and
resumes tracking the reader's position. Hover previews include the associated
answer excerpt; the directory lists only user questions.

**Conversation outline** opens a transparent, compact scrollable list of user questions;
narrow screens show only this button to preserve reading space. There are no
position counters or separate entries for replies. Replies whose preceding
question has not been loaded are omitted until that question is fetched.
Use its earlier-history control or the
existing **Load earlier messages** button to load another page. Loading preserves the reading
position and adds those questions to the locator; opening the locator does not
fetch history automatically. Attachment-only questions use filenames as excerpts.

Jumping into earlier content during a streamed reply pauses automatic following.
**Jump to latest** resumes following the answer. Switching conversations hides the old
locations while history loads, and editing/deleting messages updates the existing
locator. Navigation does not change messages, the composer draft or model context,
and makes no model calls. It adds no persistent state, API or database migration.

## Text exports

Each conversation offers **Export Markdown** and **Export JSON**. Downloads include all messages in chronological order, status, organization fields, retained document citation excerpts, and private-media references. They do not include raw tool inputs/outputs, approval tokens, local media paths, provider settings or media bytes. Markdown renders message bodies as literal fenced text to keep untrusted message markup inactive. JSON uses `formatVersion: 1`.

Exports are text snapshots, not restorable backups. Private references such as `/api/media/:id` still require the original application and authorized user; they are not portable public download links. Unavailable or legacy embedded media is omitted and marked. Export does not migrate legacy media or modify messages. Message text and citation excerpts may themselves contain information supplied by the user or model; exports are **not** a secret-redaction service. Treat downloaded files as private, even though configuration credentials are not collected.

One export allows at most 5,000 messages, 32 MiB of stored source content and 16 MiB of serialized output. Larger exports return `413 PAYLOAD_TOO_LARGE` without a partial file. There is no streaming/archive backup mode. Downloaded files are outside the application's managed-media cleanup.

## API contract

All operations require normal ownership/session and desktop Host/Cookie checks. See [API security](api-security.md).

| Endpoint | Input and response |
| --- | --- |
| `GET /api/conversations` | Optional `q`, `tag`, `state=active\|archived\|all`, `limit=1..100` and opaque `cursor`; defaults to active, 30 rows; returns `data` and `pageInfo` |
| `GET /api/conversations/:id` | Summary with `pinned`, `archived`, `tags`, timestamps and `messageCount` |
| `PATCH /api/conversations/:id` | At least one of `title`, boolean `pinned`, boolean `archived`, string-array `tags`, or `workspaceGrantId` (an active directory grant ID, or `null` to clear; an unknown or withdrawn grant returns `409 CONFLICT`); returns updated `data`, including `workspaceGrantId`; title keeps the existing 60-character display truncation |
| `POST /api/conversations/bulk-delete` | `{ "ids": ["chat-id"], "confirm": true }`; 1–50 unique IDs, 16 KiB body; returns `data.deletedCount` |
| `GET /api/conversations/:id/export?format=markdown` | `markdown` (default) or `json`; attachment response with safe filename, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` |

Unknown/duplicate query parameters and invalid fields return the shared error envelope. Search, export and bulk-delete have separate per-instance quotas of 30, 6 and 10 requests per minute. Default list reads are not charged as searches. Cursor scope includes user, query, tag and archive state. Refresh after upgrading from older cursors or changing filters; never reuse one across scopes.

## SQLite migration and maintenance

The SQL migration adds organization fields, tag relations, and SQLite FTS5 trigram tables for titles and message text. It backfills existing records and uses triggers for inserts, edits, regeneration and deletion cascades. Stable application IDs connect the index to records even after SQLite `VACUUM`; ID tokens are used internally for efficient index maintenance, not searched by the conversation API. Known structured message formats contribute only their text, excluding media payloads and tool internals. Malformed structured messages remain stored but contribute no search text.

Queries of three or more Unicode characters use case-insensitive trigram matching. Two-character queries use a literal scan fallback (SQLite's built-in lowercase folding covers ASCII). This is substring search, not semantic retrieval, token ranking or accent/Unicode normalization of message text. Very large histories and two-character scans can be slower. No large-corpus performance guarantee is implied by functional tests.

FTS tables/triggers are intentionally managed by SQL migrations, outside the Prisma schema models. Keep them when reviewing generated migrations or introspection changes. Indexes duplicate searchable text inside the private database and increase its size; they contain the same private message content as the source records. Do not copy them to a public directory.

Desktop startup backs up an existing database before applying pending migrations. Local Web migration commands do not create that backup automatically: back up an existing database before migration. Automatic tests use isolated databases, media and download directories. They verify legacy backfill, punctuation/Chinese search, archive restoration, atomic deletion, export boundaries, authenticated browser downloads and actual Electron downloads after a service restart. Installer upgrade/uninstall/reinstall acceptance remains a separate release check.

## Conversations in the sidebar

The sidebar lists the conversations on every page, below the navigation, under a **Conversations** label whose **+** starts a new one. **Manage all conversations** sits below the list; only the list itself scrolls, and its edges fade when there is more above or below. The list is grouped:

- **Pinned** — pinned conversations. Can be folded.
- **Scheduled tasks** — conversations a scheduled task writes into, marked with a calendar icon. Can be folded.
- **Recent** — every other conversation. The name shows only when a group sits above it.

Each group lists its conversations most recently active first, without dates. Folding eases a group shut and is remembered in this browser. A title cut short shows in full when pointed at.

On a window too short for everything, the navigation drops its small group names and tightens, so the list keeps room; on a window narrower than 1024 px the sidebar folds and shows over the page when its button is pointed at, or stays when pinned.

Each row is one line: its title, with a dot at its end when the conversation needs attention. Pointing at a row brings up its **⋯** menu in the dot's place, with rename (inline; Enter saves, Escape cancels), pin or unpin, archive and delete. Deleting asks for confirmation; archiving says where to restore it. When the conversation open in chat is archived or deleted, the next one opens.

The dot means one of five things, also read out to screen readers:

- **Task running** — its scheduled task is running now.
- **Queued** — an answer waits for a place to run (a hollow ring).
- **Answering** — an answer is being written in it: in this window, in another one, or one this window started and then left.
- **Waiting for your approval** — its latest answer asks for an approval.
- **New answer** — an answer ended there that has not been opened yet. Opening the conversation clears it; the conversation open in chat never shows it.

Clicking a row on another page opens that conversation in chat. More rows are read as the list is scrolled to its end. The sidebar follows the service's account of what happens to the conversations as it happens (an answer starting or ending, a task running, a conversation renamed or deleted in another window) and reads the list again then; it also reads it again when the window comes back into view. There is no polling. The chat page and the sidebar share one list: a change made in either shows in both.

## Several conversations at once

An answer belongs to the service, not to the page that asked for it. Switching to another conversation, going to another page or reloading leaves the answer being written; several conversations can answer at once. Opening a conversation that is answering shows the answer from where it has got to and follows it to the end, with **stop** available. A conversation answers one turn at a time. What you write there while it answers can be queued (Enter, or **Queue to send** beside **stop**): queued messages show above the composer, where each can be edited or removed, and are sent in order once the answer ends and no approval is waiting. The queue belongs to the conversation and is kept in this browser, like drafts; a tool or skill choice is not queued.

### When every place is taken

How many answers (and other model calls) run at once is **Maximum concurrent calls** in Settings → Models, 8 unless changed. An answer past that is not refused: it waits, its conversation shows **Queued — n ahead** and a hollow dot in the sidebar, and it starts by itself when a place frees up. Your own conversations go before tasks waiting for a place. Your message is saved as soon as it is queued, so a reload still shows it; **stop** takes a queued answer out of the queue. Once an answer has started, everything it does (its steps, the summaries it writes, a search it makes) works within its place and is never refused part way.

When the provider is busy or rate-limited, a call is retried with growing waits, or after the wait the provider asks for (up to a minute), about half a minute in all; the answer says **The service is busy — retrying in n s (attempt n)** meanwhile. With a fallback model configured, the failing model gets two quick retries and the fallback takes over.

When an answer ends while its conversation is not open, the row gets the **New answer** dot. In the desktop app, when the RiA window is not in front, a system notification also says the answer is ready (or waits for approval, or could not be finished); clicking it opens the conversation. Tasks keep their own notification setting instead.

The service keeps running answers only while it runs: an answer still being written when the application quits is lost, as before, and its run record says it was interrupted.

## Unsent drafts

What is typed into the composer is kept per conversation. Switching conversations, switching pages, reloading or restarting the application all return it to the same conversation.

Attachments are uploaded when they are chosen, and the draft keeps the reference the server returned rather than the file: a file cannot be handed back after a reload, a reference can, so a draft is still sendable after a restart. An uploaded attachment that is never sent becomes an unreferenced file, which the media store's existing grace-period cleanup reclaims — an abandoned draft costs disk for a while and nothing more.

A draft is cleared only once the turn actually produced an answer. A send that fails puts the text back so it can be retried. Stopping does not: the question was delivered and is in the conversation, and putting it back would invite sending it twice.

Drafts and the conversation/task panel layout are kept in the browser's local storage under `ria.chat.*` keys. Values saved by builds from before the RiA rename, under `private-ai.chat.*`, are read the first time they are needed and moved to the current keys; the panel layout is applied from either key before the first paint. A value already saved under the current key wins over the old one.

## Stopping a turn

While a turn is running, the send control is replaced by **stop**. Stopping asks the service to stop the turn, wherever it was started: whatever the model produced stays on screen and is stored once, as an interrupted answer. Leaving the conversation does not stop it. Stopping does not mean the provider stopped billing for what it had already produced.

## Keyboard and copying

- User bubbles omit the role header. Edit and delete controls appear just below
  the bottom right corner on hover or keyboard focus, without changing bubble
  size. Touch devices keep these controls visible.
- **Enter** sends, **Shift+Enter** adds a line; an Enter that is part of an input-method composition does not send.
- **Escape** closes a delete confirmation; with none open, it stops a running turn.
- Every answer has a **copy** control, and a code block has its own **copy code** control that appears on hover or focus — selecting text across a scrollable code box is a poor substitute. When the clipboard is unavailable the answer is not interrupted and the text stays selectable.

## Following the scroll

New messages are followed while the reader is already at the bottom, and are ignored once they have scrolled up, where a **jump to latest** control appears. The decision is made by measuring the position at the moment content arrives rather than from a remembered scroll event: a scroll that has not been delivered yet would otherwise read as "still following" and pull the view down in the middle of an answer.

## Summary invalidation

Editing, deleting or successfully regenerating history clears the stored compression
and increments its history revision in the same transaction. Saving a new message
changes neither. Rewriting a saved message, as an answer continuing after an approval
does, increments the revision and clears the summary unless the summary provably ends
before that message. Summaries are built from stored message content rather than a
stale browser transcript. Stored messages use the same bounded record form as in-turn folds, without replaying
approval metadata, reasoning or attachment bytes.
A model result is saved only if the history revision
still matches; a slower result cannot restore obsolete decisions after an edit.
A missing covered message causes fallback to existing bounded history excerpts.
Cached summaries are reused only when both revision and covered identity match.

Where the summary ends, the transcript shows a marker that opens to what it says.

The additive migration drops earlier unverifiable summaries while preserving all
original messages. Desktop startup snapshots existing data before this migration.
Versioned summaries survive portable restore with remapped message identities;
legacy or inconsistent summary evidence is discarded and can be recomputed later.
This is compression invalidation, not deletion of the conversation history.

Row menus in the sidebar open from the keyboard and return focus to their button when dismissed; cancelling a rename keeps the title. Export actions on management cards use the same icon-and-button treatment as the other secondary actions.
