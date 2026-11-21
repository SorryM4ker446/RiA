# Media library

Open **Media library** in the conversation sidebar, or follow its link from **Settings → Storage**. The browser and Electron use the same `/media` page and private media APIs. The library shows stored uploaded images and generated images/videos.

## Browse and inspect

Filter by media type, upload/generation origin, or reference state. Results load newest first in pages of 24; **Load more assets** fetches another page. Image thumbnails load lazily. Video files load only when their details are opened, with native playback controls. Missing files or unsupported codecs show a preview error; downloading does not require successful preview decoding.

Details include file size, MIME type, creation time, model, prompt, recorded generation parameters, source conversation and reference counts. Up to ten message references and ten dependent results are shown, with full counts. **Restore and open conversation** explicitly unarchives an archived conversation; opening an active conversation does not change its state.

**Download original** checks authorization with HEAD and then streams the original file through the browser/Electron download manager. It does not load an entire video into JavaScript memory. The filename uses the asset UUID and recognized extension. A downloaded file is an unencrypted copy outside the app's authorization boundary; store it privately.

## Pictures made in chat

In chat, the model can make a picture itself with the `generateImage` tool instead of the user switching to the image mode. It writes the complete description from the conversation, uses the default image model from **Settings → Models**, and can build on earlier pictures by their media ids: every image in the conversation, attached or made, reaches the model with its id, including pictures made in the image mode and, for a model that cannot see images, a line where each picture was. "Now make the background night" therefore passes the previous picture as a reference image.

The result is stored like any other generated image (`generated-image`, with the conversation as its source and a recipe that includes the optional aspect ratio) and shown as a picture card in the answer where it was made, between the text written before and after it (also once the conversation is read back, from the steps the answer recorded); while it is being made its place already holds the room the picture takes, so it lands without moving the text. It has the same reuse action as image-mode results. The answer refers to the picture, so cleanup and deletion protect it once the answer is saved. If a picture is deleted from the library while the answer is still being written, the answer and its remaining picture references are saved. Regenerated answers record their pictures the same way. The chat model gets the media ID and generation status. A model that accepts images also gets the picture for the rest of that turn when it can be read, so it can check the result and correct it once. Text-only results, including historical tool results and pictures that could not be read, explicitly indicate that visual inspection is unavailable. Chat, image mode and library regeneration all record provider-reported image charges under the `media` source when OpenRouter returns a cost.

The model currently answering the turn determines whether the tool returns image pixels, including after chat model fallback. Chat, image mode and library image regeneration share one quota. The default is 12 requests per 60 seconds, adjustable under **Settings → Models → Model call limits**.

Each picture costs money, so the call follows the conversation's approval rule with its own test. Under full access it runs. Under Ask, Accept edits and Auto, the reviewer model (the internal sub-agent model, else the chat model) reads the user's own messages and lets the call run only when the latest of them asks for a picture to be made or changed. Each paid call receives its own verdict, even if the prompt repeats. A picture the model decides on by itself, an unreadable verdict or a review that fails or times out waits for the user's approval. The approval card shows the description, the number of reference pictures, the aspect ratio and a cost note. Stopping the turn stops the generation. A picture already returned by the provider may remain in the library as an unreferenced file until the normal cleanup.

Without a default image model, or with no key for its provider, the tool is not offered and the system prompt tells the model why. Sub-agents are not given the tool. The image mode stays for prompts that are already written; while the image mode holds text that reads as a question, the composer says that the image mode draws text rather than answering it and offers to switch back to chat.

## Generate again

New generation results store a versioned recipe: resolved model ID, normalized prompt, ordered reference-image IDs, an image's optional aspect ratio, and video aspect ratio plus optional duration/FPS. Quantity remains one. An optional `chatId`, supplied by the chat UI, records the source independently of message references. If the source conversation is deleted, the file and recipe remain, without a source pointer.

The library itself no longer offers regeneration: the detail's ⋯ menu has **Show in File Explorer** instead (below), and regeneration stays an API (`POST /api/media/:id/regenerate`). It requires explicit confirmation and reuses the stored recipe through the normal image/video generation service, including its input validation, configuration checks and quota. A successful request creates a separate file in the library. It does not replace the original file, alter chat history or append a chat message. Failed requests retain the original resource and references.

## Viewing and finding a file

A picture opens in RiA's image viewer from the conversation (double-click it, or its **View larger** button) and from the media detail (the same two ways). Both use one viewer (`src/components/media/image-viewer.tsx`): it opens fitted to the window in proportion, zooms in and out (buttons, `+` / `-`), shows the picture at its own size (`1`) and fits it again (`0`), and once the picture is larger than the window it can be dragged or moved with the arrow keys. Esc or the close button returns focus to the button the picture is opened with, without moving the page. Opened from a conversation, the viewer links to that asset's media detail (`/media?asset=<id>`).

The full prompt is shown only in the media detail, where it can be copied; pictures in conversations and the library's cards no longer show it on hover.

**Show in File Explorer** selects the asset's own file. The service resolves the path from the asset id with the same checks a read makes (`POST /api/media/:id/locate`: inside the media folder, the file itself, not a link, the recorded size) and returns `{ data: { absolutePath } }`, or `404` when the file is gone; the desktop app only shows what it is handed (`revealPath`). Outside the desktop app the action says it needs the desktop app.

The recipe records application request parameters, not a provider's effective output settings. Unspecified defaults and remote model behavior can change. The installed OpenRouter video adapter does not forward the SDK's `fps` option, so a saved requested FPS is not a guarantee about the actual video's frame rate. Reusing a recipe does not promise identical output. There is no fallback model substitution.

Uploaded files and older generated assets without complete recipes remain browsable, downloadable and safely deletable, but cannot be regenerated. Recipes are not reconstructed from old descriptions. An unavailable original model or missing input metadata prevents regeneration; missing input bytes fail before the provider call. Legacy inline media enters the library only after opening its conversation triggers the existing migration.

Requests are not idempotent. If a response is lost after a successful generation, refresh the library before deciding to retry: another confirmed request may create another result and incur another charge. Quotas are not a spending cap. If an unreferenced input is deleted during the first provider call, persistence fails rather than creating a dangling dependency; a completed file can remain as an orphan until the normal cleanup grace period expires.

## Retention and cleanup

**Delete asset** requires confirmation and permanently deletes only an asset with no message or generation-input references. Referenced resources show their links and cannot be deleted. Removing messages or source conversations does not automatically remove files. Generated outputs retain their inputs for future regeneration; deleting those outputs releases their inputs with a fresh 24-hour cleanup grace period.

**Disk usage and cleanup** reuses the storage page's actual managed-file usage, reference statistics and confirmed cleanup. Recent files and referenced inputs stay protected. Explicit individual deletion may remove an unused file immediately; bulk cleanup still requires the grace period. No automatic background cleanup is added. See [Media storage](media-storage.md) for path checks, orphan/tombstone handling and backups.

## API

| Request | Contract |
| --- | --- |
| `GET /api/media/library` | `{ data, pageInfo: { nextCursor, hasMore } }`; `type=all/image/video`, `kind=all/attachment/generated-image/generated-video`, `usage=all/referenced/unused`, `limit=1..100` (default 24), optional `cursor` |
| `GET /api/media/:id/details` | `{ data }` with safe file metadata, recipe or null, source/associated conversations, message and generation reference counts, dependent result IDs and `regenerationUnavailable` reason or null |
| `POST /api/media/:id/regenerate` | Strict JSON `{ "confirm": true }`, at most 16 KiB; HTTP 201 `{ modelId, asset }` on success |
| `POST /api/media/:id/locate` | No body; `{ data: { absolutePath } }` for the asset's own file after the checks a read makes, `404` when it is missing |

Cursors are scoped to the exact filters. Unknown or duplicate query parameters, malformed cursors and invalid limits return 400. Lists/details do not expose filesystem paths or configuration secrets. Asset URLs still require the local access credential. Unknown asset IDs return 404; a missing credential, origin checks and quotas use the [standard API error contract](api-security.md).

Regeneration attempts have a user quota of six per minute. Once a valid recipe is resolved, calls also consume the existing shared image quota (six per minute) or video quota (three per minute). Moving between chat generation and library regeneration does not bypass those quotas. Existing attachment/output size limits and desktop Cookie/Host checks remain unchanged.

No configuration variable or external service is required for browsing, downloading or cleanup. Regeneration uses the existing configured OpenRouter key. SQL migrations add nullable recipe/source metadata and input-reference links without rewriting old media; desktop upgrades use the existing database backup procedure. That backup still excludes media files.
