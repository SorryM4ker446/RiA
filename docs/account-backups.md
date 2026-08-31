# Account backups and restore

Open **备份与恢复** from the chat sidebar or Settings in either the browser or Electron. **创建备份** makes a private archive; **下载备份** exports it as a `.paib` file. Importing a file validates and saves an archive without applying it. Select **恢复**, inspect the counts, and type **恢复** to replace the current account's business data. Restore does not merge accounts.

## Contents and privacy

An archive includes conversations/messages/tags, memories and embeddings, tasks, extracted document text and indexes, private media files and references, generation recipes, account model preferences, retention settings, and up to 5,000 recorded model attempts. Original PDF/Word source files are not retained by document import and are not included.

Account identity, passwords, application sessions, desktop encrypted settings, provider API keys, proxy configuration, logs, other accounts, and other backups are excluded. Structured media paths and tool approval credentials are omitted. Conversation text, tool outputs, recipes and documents can themselves contain sensitive information that the user entered; this content is preserved. **Archives are not encrypted.** Protect exported files like the original data and only import trusted archives. Checksums detect corruption, not who authored the file.

The portable archive is a versioned JSON manifest with SHA-256 checksums followed by the original media bytes. It is not a SQLite file or ZIP archive and is not executed as code. Restore rejects unknown formats, invalid relationships, duplicate identifiers, cycles, unrecognized fields, invalid media signatures and checksum/length mismatches. There are no archive-selected filesystem paths.

Backups are private files under `backups/<hashed-owner>/` beside the configured media directory. For the default layout this is next to `app.db`. These archives are separate from Electron's existing timestamped database migration `.bak` files. Automated account cleanup never removes migration backups, unknown files, links or other accounts' archives.

## Restore safety

Stop generation and wait for other requests to finish first. Backup, import and restore operations use a single-process maintenance gate: an in-flight request returns HTTP 409 to a maintenance operation, and a business request during maintenance receives HTTP 503. Chat consumption and persistence retain the gate even after an HTTP reader disconnects. There are no forced cancellations or unlimited retries.

Restore validates files, stages new immutable media paths, and creates a safety archive of the current account before changing business rows in one SQLite transaction. Login state and other accounts remain unchanged. Any database failure rolls back the business changes. IDs and internal media/document/source references are remapped, allowing import into another local account without collisions. A restore requires space for the archive, the safety archive and another copy of its media. Large restores remain subject to the existing SQLite transaction timeout; a timeout rolls back rather than extending it indefinitely.

Pending messages become errors, historical pending tool approvals become denied, and restored task reminders are disabled. Re-enable reminders deliberately after checking their dates. Model preferences and backup retention settings return to their archived values. Refresh other open windows after restoring; local per-conversation controls in those windows are not a synchronized database snapshot.

Previous live media files and files staged by interrupted restores are left as managed orphans, eligible for the existing confirmed media cleanup after its grace period. Archive cleanup errors after a successful commit do not turn that restore into a failure; the response reports `cleanupFailed`. Disk failure, abrupt termination and operating-system interference cannot guarantee file durability. Keep a second copy on separate storage.

Unmigrated legacy video links prevent portable backup creation, including a restore's safety backup. Open the relevant history with its old video directory available to finish migration first. Alternatively close the service and back up SQLite, media and the legacy video directory together. Missing original files cannot be reconstructed.

## Limits and retention

- Archive: 512 MiB; JSON manifest: 32 MiB. Core collections and total messages: at most 10,000 each; documents: 100; document terms: 100,000; usage: 5,000.
- Existing file limits remain 8 MiB per attachment, 20 MiB per generated image and 100 MiB per generated video.
- Imports send ordered chunks of at most 8 MiB. This does not raise the existing API/Proxy body limits. A user can have one upload in progress, with a one-hour lifetime; restarting the service requires re-importing.
- Defaults: retain archives for 30 days and keep at most 10. Configure 1–365 days and 2–20 copies on the backup page. Automatic cleanup always retains the newest completed archive; a newly created safety archive is also preserved during that restore's cleanup.
- Cleanup runs after backup creation, approximately 30 seconds after service startup, and hourly while it remains running. Busy startup checks wait until the next scheduled check. Incomplete files older than an hour are eligible. This is automatic cleanup, not scheduled backup creation.

Explicit deletion is permanent and may delete the last archive after confirmation. The built-in archive is for bounded single-account transfers and recovery. For larger datasets or a complete installation snapshot, close every service that uses the data and copy the entire database/media/data directories. Do not run an external database writer or a second application service during an in-app backup or restore; the maintenance gate only coordinates this process.

## Local API

All endpoints retain the normal session, Host and Origin checks and sanitized error envelope. IDs are server-generated UUIDs; callers cannot select a path or account.

| Endpoint | Contract |
| --- | --- |
| `GET /api/backups` | List owned completed archives |
| `POST /api/backups` | Empty body; create an archive, HTTP 201 |
| `GET /api/backups/:id` | Inspect manifest counts; `?download=1` streams the archive |
| `POST /api/backups/:id` | Strict `{ "confirm": true }`, at most 16 KiB; restore and return `safetyBackupId`, `restored`, `cleanupFailed` |
| `DELETE /api/backups/:id` | Permanently delete only that owned archive |
| `POST /api/backups/import` | Strict `{ "bytes": integer }`; return upload ID and chunk size |
| `PUT /api/backups/import/:id?offset=0` | Sequential `application/octet-stream` chunk; return next offset |
| `POST /api/backups/import/:id` | Empty body; validate and finish upload, HTTP 201; no restore |
| `DELETE /api/backups/import/:id` | Cancel an in-progress upload |

See [API security](api-security.md) for quotas, and [Model settings and usage](model-usage.md) for the preference/usage data contained in archives.
