# Media library

Open **媒体资源库** in the conversation sidebar, or follow its link from **存储管理**. The browser and Electron use the same `/media` page and private media APIs. The library shows uploaded images and generated images/videos owned by the current user.

## Browse and inspect

Filter by media type, upload/generation origin, or reference state. Results load newest first in pages of 24; **加载更多资源** fetches another page. Image thumbnails load lazily. Video files load only when their details are opened, with native playback controls. Missing files or unsupported codecs show a preview error; downloading does not require successful preview decoding.

Details include file size, MIME type, creation time, model, prompt, recorded generation parameters, source conversation and reference counts. Up to ten message references and ten dependent results are shown, with full counts. **恢复并打开会话** explicitly unarchives an archived conversation; opening an active conversation does not change its state.

**下载原文件** checks authorization with HEAD and then streams the original file through the browser/Electron download manager. It does not load an entire video into JavaScript memory. The filename uses the asset UUID and recognized extension. A downloaded file is an unencrypted copy outside the app's authorization boundary; store it privately.

## Generate again

New generation results store a versioned recipe: resolved model ID, normalized prompt, ordered owned reference-image IDs, and video aspect ratio plus optional duration/FPS. Quantity remains one. An optional owned `chatId`, supplied by the chat UI, records the source independently of message references. If the source conversation is deleted, the file and recipe remain, without a source pointer.

**重新生成** opens a confirmation that warns about another model call and possible fees. Confirming reuses the stored recipe through the normal image/video generation service, including its input validation, configuration checks and quota. A successful request creates a separate file in the library. It does not replace the original file, alter chat history or append a chat message. Failed requests retain the original resource and references.

The recipe records application request parameters, not a provider's effective output settings. Unspecified defaults and remote model behavior can change. The installed OpenRouter video adapter does not forward the SDK's `fps` option, so a saved requested FPS is not a guarantee about the actual video's frame rate. Reusing a recipe does not promise identical output. There is no fallback model substitution.

Uploaded files and older generated assets without complete recipes remain browsable, downloadable and safely deletable, but cannot be regenerated. Recipes are not reconstructed from old descriptions. An unavailable original model or missing input metadata prevents regeneration; missing input bytes fail before the provider call. Legacy inline media enters the library only after opening its conversation triggers the existing migration.

Requests are not idempotent. If a response is lost after a successful generation, refresh the library before deciding to retry: another confirmed request may create another result and incur another charge. Quotas are not a spending cap. If an unreferenced input is deleted during the first provider call, persistence fails rather than creating a dangling dependency; a completed file can remain as an orphan until the normal cleanup grace period expires.

## Retention and cleanup

**删除资源** requires confirmation and permanently deletes only an asset with no message or generation-input references. Referenced resources show their links and cannot be deleted. Removing messages or source conversations does not automatically remove files. Generated outputs retain their inputs for future regeneration; deleting those outputs releases their inputs with a fresh 24-hour cleanup grace period.

**磁盘占用与清理** reuses the storage page's actual managed-file usage, reference statistics and confirmed cleanup. Recent files and referenced inputs stay protected. Explicit individual deletion may remove an unused file immediately; bulk cleanup still requires the grace period. No automatic background cleanup is added. See [Media storage](media-storage.md) for path checks, orphan/tombstone handling and backups.

## API

| Request | Contract |
| --- | --- |
| `GET /api/media/library` | `{ data, pageInfo: { nextCursor, hasMore } }`; `type=all/image/video`, `kind=all/attachment/generated-image/generated-video`, `usage=all/referenced/unused`, `limit=1..100` (default 24), optional `cursor` |
| `GET /api/media/:id/details` | `{ data }` with safe file metadata, recipe or null, owned source/associated conversations, message and generation reference counts, dependent result IDs and `regenerationUnavailable` reason or null |
| `POST /api/media/:id/regenerate` | Strict JSON `{ "confirm": true }`, at most 16 KiB; HTTP 201 `{ modelId, asset }` on success |

Cursors are scoped to the current user and exact filters. Unknown or duplicate query parameters, malformed cursors and invalid limits return 400. Lists/details do not expose filesystem paths or configuration secrets. Asset URLs still require authentication. Cross-user asset IDs return 404; invalid sessions, origin checks and quotas use the [standard API error contract](api-security.md).

Regeneration attempts have a user quota of six per minute. Once a valid recipe is resolved, calls also consume the existing shared image quota (six per minute) or video quota (three per minute). Moving between chat generation and library regeneration does not bypass those quotas. Existing attachment/output size limits and desktop Cookie/Host checks remain unchanged.

No configuration variable or external service is required for browsing, downloading or cleanup. Regeneration uses the existing configured OpenRouter key. SQL migrations add nullable recipe/source metadata and input-reference links without rewriting old media; desktop upgrades use the existing database backup procedure. That backup still excludes media files.
