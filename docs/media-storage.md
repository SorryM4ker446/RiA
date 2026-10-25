# Media storage and migration

## Storage layout

New generated images, videos, and uploaded attachments are written to private file storage. SQLite holds asset metadata, generation recipes, source conversations, message references and generation-input references, not embedded image/video bytes. Generation recipes contain prompts and input identifiers, so database backups also contain that private content.

- Local browser development: `.desktop-data/dev/media/` next to `app.db`.
- Installed desktop: `%APPDATA%/RiA/data/media/`.
- Isolated tests: their own temporary database and media directories.
- Local Web overrides: set `MEDIA_DIRECTORY` to an absolute private directory. Without it, an absolute `file:` SQLite database URL is required. There is no working-directory fallback for new media.

Electron explicitly passes its resolved user-data media directory to the local server. Changing the installation directory or rebuilding `.desktop-runtime` does not move this storage. Media files are placed in a hashed workspace directory with server-generated UUID filenames. Client filenames and relative paths are never used to choose a filesystem destination.

Back up the SQLite database **and the entire media directory together while the app is closed**. Existing automatic pre-migration database backups do not include media files. Reinstallation retains media only while the user-data directory is retained; manually deleting it removes the data.

## API contract

All media APIs require the local access credential. Desktop requests additionally pass the existing Host and desktop-cookie checks.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/media/upload` | Multipart `files` fields; returns `{ data: [{ assetId, relativePath, mediaType, byteSize, url, filename }] }` |
| `GET /api/media/:id` | Private binary response; supports single byte ranges and `?download=1` |
| `HEAD /api/media/:id` | Same authorization and file checks, headers only |
| `DELETE /api/media/:id` | Explicit permanent removal of an unreferenced asset; referenced assets return 409 |
| `GET /api/media` | Storage counts, actual managed-file bytes, and cleanup eligibility |
| `GET /api/media/library` | Filtered, cursor-paginated metadata for stored images and videos |
| `GET /api/media/:id/details` | Resource metadata, source conversations, references and stored generation parameters |
| `POST /api/media/:id/regenerate` | Requires `{ "confirm": true }`; returns HTTP 201 with `{ modelId, modelProvider, asset }` for a new, independent result |
| `POST /api/media/cleanup` | Reclaims expired unreferenced assets and recognized orphan files |

`POST /api/image` and `/api/video` now return `{ modelId, modelProvider, asset }`, where `asset` has the same media reference fields as uploads. They no longer return `dataUrl` or a public `videoUrl`. Both accept a `model` reference (`{ providerId, modelId }`) and validate it against **My models** before calling the provider. Reference images must use uploaded `/api/media/:id` URLs, not remote URLs, file URLs, or data URLs. Update external clients to upload first.

The chat UI follows this contract automatically and passes the active `chatId` to record the generation source. External image/video clients may omit `chatId`; no source is inferred. Server-side model calls materialize stored image references into bytes and document references into extracted text only for the current request; providers do not fetch private local API URLs. The model's attachment context is bounded to the newest four files, 20 MiB and 100,000 document-text characters. Older attachments outside these limits remain in history and receive an explicit omission note in that request. Current-turn documents exceeding the text limit are rejected instead of silently truncated. See [Media library](media-library.md) for image/video list/detail contracts and regeneration behavior.

## PDF and Word in chat

In chat mode, use the paperclip or drag files into the composer to attach PDF and Word (`.docx`) files alongside images. Uploading parses all selected documents with the existing isolated document parser before storing any file in that batch. The composer displays a compact document card, a processing indicator and individual removal actions. Drafts retain uploaded references across reloads; sent messages offer original-file downloads and retain their references across restarts and portable backup/restore.

Sending resolves each reference under the local workspace credential and parses the original immutable bytes again. Only the extracted text is sent to the configured chat provider, labelled as reference material inside the user message. The database retains the original file reference, not a client-supplied copy of the extracted text. Documents work with text-only chat models; mixed image/document requests still require image input support for the images. Word table structure and PDF page labels use the existing parser. File selection alone does not call the model.

Chat attachment upload does **not** create knowledge documents, chunks, embeddings or memories. To add a file to the knowledge library, import it there explicitly. Document assets share existing message-reference protection, orphan cleanup and backup handling; they are downloaded from chat rather than listed in the image/video media library. Unsent, unreferenced uploads remain subject to the existing 24-hour cleanup grace period, so an abandoned draft may require reattachment after cleanup.

Legacy `.doc`, encrypted documents and PDFs without searchable text are unsupported. Convert `.doc` to `.docx`; run OCR on scanned PDFs first. Image/video generation continues to accept images only. Switching generation mode while a document is attached requires removing the document or returning to chat before sending.

## Limits and checks

- Chat attachments: PNG, JPEG, WebP, GIF, PDF and Word (`.docx`); no SVG or legacy `.doc`. Generation reference inputs remain image-only.
- Up to 4 attachments, 8 MiB per file, 20 MiB combined. Video generation accepts one reference image.
- Multipart requests: 21 MiB including framing; generation and message-write JSON: 2 MiB. Chat JSON has no byte limit so terminal scripts, approvals and history can be sent in full; attachment count and file-size checks still apply.
- Generated output: images up to 20 MiB, videos up to 100 MiB. Supported video containers are MP4/QuickTime with an `ftyp` header and WebM with an EBML header.
- MIME types must match recognized file signatures. This is not a malware scan or complete media-decoder validation.
- Document MIME types must agree with their filename extension and parse successfully. Missing/`application/octet-stream` document MIME hints are normalized by extension and then validated against the actual bytes. Documents also retain the parser's 200-page, 100,000-character, bounded-worker and timeout limits.
- Size checks read the request stream incrementally; omitting or lying about `Content-Length` does not bypass the limit.
- Asset lookups resolve managed files before reading them. Managed paths are checked against server-generated names, and symlinks/junctions at the media root, owner directory, or file are rejected.
- Responses use private/no-store caching, `nosniff`, and a restrictive content security policy. Video range requests return 206 or 416 as appropriate.

Single-process quotas and browser Origin checks are active; see [API security](api-security.md). Public Web deployment still needs a separate shared-state, storage and operational security design. This file-backed service targets a single local application instance.

## Existing messages

Loading conversation history or an individual message attempts to migrate legacy Base64 images and image attachments. It writes the file first, then atomically changes the message and its references. Concurrent readers cannot overwrite a newer message. If import fails (invalid data, oversized file, missing source, disk failure), the original message is retained for compatible reading or recovery. An interrupted import can leave an orphan file, reclaimable only after the grace period.

Legacy `/generated-videos/<timestamp>-<uuid>.<extension>` references can be imported while the original file still exists. By default the importer reads the runtime's old `public/generated-videos` directory; `LEGACY_VIDEO_DIRECTORY` can point to a private backup of that directory. It never downloads arbitrary legacy URLs and does not delete the original source file. Raw `/generated-videos/` HTTP access is blocked in both Web and desktop modes.

Before rebuilding an old standalone runtime that contains generated videos, back up those files outside `.desktop-runtime`, configure `LEGACY_VIDEO_DIRECTORY` to that location, and move the old runtime copies out only after confirming the backup. The build refuses to erase a nonempty legacy video directory. Public generated videos are excluded from new desktop runtime copies. Files already lost during a previous upgrade cannot be recovered by this migration.

Runtime-only filesystem access is excluded from Turbopack file tracing. Preparation fails before replacing an existing runtime if standalone output contains development data, another runtime, repository history, or old packages. Runtime/package verification also rejects these directories and publicly served generated videos.

## Deletion and cleanup

Deleting a message, replacing its media, regenerating later history, or deleting a conversation releases only the corresponding references. Shared assets remain available to other messages. The last-use timestamp is updated when references change, so a just-detached old asset receives a fresh 24-hour grace period.

Stored generation recipes also protect their reference images. An input cannot be deleted or reclaimed while any generated output depends on it, even if no message references it. Removing an output releases only its dependencies and refreshes the inputs' grace period. Deleting a source conversation clears its source pointer without deleting the generated files. Reference counts and cleanup eligibility include both message and generation references.

The storage page and media library require confirmation before reclaiming eligible files. Cleanup does not remove referenced assets, recent uploads/generations, or unrecognized files. Failed deletions retain a tombstone and can be retried. There is no automatic background cleanup. The explicit asset DELETE endpoint does not wait for the grace period, but still refuses to delete a referenced asset.

Deleted files cannot be restored without a backup. **Backup & restore** creates portable workspace archives containing business data and managed media, with a safety backup before confirmed restore. It also cleans expired backup archives automatically; media cleanup itself still requires confirmation. See [Workspace backups](workspace-backups.md) for archive limits, legacy-video migration requirements and rollback behavior. For a complete installation snapshot or larger datasets, continue to back up the database and media directory together while the app is closed.
