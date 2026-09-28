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

## 未发送的草稿

聊天输入框里的内容按会话保存：切换会话、切换页面、刷新或重启应用后回到同一个会话，输入框仍是写了一半的内容。附件在**被选中时**就上传，草稿保存的是服务器给出的引用而不是文件本身——文件在重载后无法取回，引用可以，所以草稿在重启后仍能直接发送。上传后没有发送的附件会变成无引用文件，媒体存储的既有回收策略会先保留一段宽限期再清理，废弃的草稿因此只占一点磁盘。

草稿在**这一轮真的产生了回答**之后才清除。发送失败时输入内容会被放回，可以直接重发；点"停止"则不会放回——问题本身已经发出并存在于会话里，放回输入框等于邀请用户再发一次。

## 停止生成

一轮回答进行中时，发送按钮被"停止"取代。停止放弃的是对服务商的请求，不是已经产生的内容：已输出的部分留在页面上并按被中断的回复保存。停止不代表上游不计费，费用视图照常记录。

## 键盘与复制

- **Enter** 发送，**Shift+Enter** 换行；输入法组合中的 Enter 不触发发送。
- **Escape** 关闭删除确认框；没有确认框打开时，停止正在生成的一轮。
- 每条回答有**复制**按钮；代码块有独立的**复制代码**按钮（悬停或聚焦时出现），代码块里跨行选取容易被滚动容器打断。剪贴板不可用时不会打断回答，文字仍可手动选取。

## 跟随滚动

新消息到达时，读者在底部就跟随；已经往上翻就不动，并把"回到最新"留在视口底部。强行把视图拉到底会毁掉他刚找到的位置，所以判断的是位置而不是消息条数。
