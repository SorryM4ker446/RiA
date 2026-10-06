# Desktop development and release

The Windows desktop application is a thin Electron shell around the existing Next.js application. Electron owns the window, local service lifecycle, API-key encryption, data paths, and operating-system integration. Chat and tool behavior remains in Next.js.

## Runtime layout

Development data is stored in:

```text
<repository>/.desktop-data/dev/app.db
```

Installed application data is stored in:

```text
%APPDATA%/Private AI Assistant/data/app.db
```

The same data directory contains file-backed `media/`, encrypted settings, migration backups, and `logs/desktop.log`. Reinstalling or uninstalling the application does not intentionally delete this user-data directory. Backups must include both SQLite and media; automatic database migration backups cover SQLite only. See [Media storage and migration](media-storage.md).

The shared **备份与恢复** page stores unencrypted portable workspace archives under `backups/`, alongside but separate from database migration `.bak` files. It supports export/import, confirmed restore with a safety archive, and retention cleanup while the service runs. **模型与用量** stores workspace defaults and optional fallback in SQLite; provider keys remain in desktop encrypted settings and are never added to these settings or archives. See [Workspace backups](workspace-backups.md) and [Model settings and usage](model-usage.md).

Imported document text and its search index are stored inside SQLite and included in its backups. Original PDF/Word files are not retained. See [Document knowledge](document-knowledge.md) for supported formats, source references, privacy and reindexing. Document import works without a model key; chat sends relevant excerpts to the configured model.

The shared Web/desktop application client uses one SQLite connection per service process. Concurrent queries wait in the pool for up to 30 seconds instead of competing for SQLite's single write lock. Interactive transactions use the same 30-second connection-acquisition limit; their execution timeout remains unchanged. A lock held by another process still times out after 5 seconds. These limits are applied to the Prisma datasource without changing `DATABASE_URL`, database/media paths, or the schema. Restart an already-running service after updating the client configuration. This policy does not coordinate multiple service processes or turn SQLite into a multi-instance database.

The packaged Next.js server and Prisma runtime are copied to:

```text
resources/.desktop-runtime
```

## Development

Run the complete desktop development stack with:

```powershell
npm run desktop:dev
```

The main process chooses an available loopback port, applies SQLite migrations, starts Next.js, waits for `/api/health`, sets a random HttpOnly desktop-session cookie, and then opens the window. Closing the application stops the child service. If the child service exits on its own, the exit code is written to the desktop log, the task reminder checks stop, and the window is replaced with the same page a failed launch shows. It is not restarted automatically, so a crash stays visible instead of being hidden behind a restart loop.

The development terminal stays attached while Electron runs. Next.js startup and request output goes to `.desktop-data/dev/logs/desktop.log`, so a quiet terminal after TypeScript compilation does not by itself indicate a stall. The launcher must allow Electron's window to show on Windows; only background services and intentionally hidden smoke tests use hidden process startup.

When restarting the local service, Electron first leaves the old page, then reloads Settings after the service is ready. The temporary blank page prevents the old development hot-reload connection from aborting navigation during restart; cookies and persisted data are retained.

Desktop logs rotate at 2 MiB per file, retaining the active file plus three archives (`desktop.log.1` through `.3`), up to 8 MiB total. Next stdout/stderr goes through the same parent-process writer and redaction rules instead of a file descriptor that bypasses rotation. Complete output lines are buffered across chunks for redaction; lines over 16 Ki characters are omitted, and entries larger than a file are replaced with an omission marker. Oversized logs from older versions are capped when rotated. Rotation/write failures do not stop the app; diagnostics may be lost when the log directory is unwritable. Do not use these bounded diagnostic files as durable audit logs.

There is no browser-only variant. `npm run dev` still starts the bare Next.js service for a fast loop and for the development-mode desktop smoke, but it is not a delivery form and it does not exercise Electron IPC or the desktop-session boundary.

## API keys and settings

Open the Settings page from the chat header. OpenRouter, DeepSeek and Tavily keys are encrypted by Electron `safeStorage`, which uses Windows DPAPI. The renderer receives only boolean “configured” state and cannot read decrypted values. Each provider's key is stored and cleared independently: configuring DeepSeek alone leaves OpenRouter untouched, and the local service decides which provider a stored model belongs to. DeepSeek serves chat models only, which the settings page states where the key is entered so it cannot be mistaken for a way to enable image or video.

Saving settings restarts the local Next.js service so that server-only environment variables are refreshed. Plaintext API keys are not written to SQLite, normal logs, the standalone runtime, or the installer.

The settings page also supports an outbound HTTP proxy, OpenRouter site name, and HTTP referrer. Chat and media model choices remain conversation-scoped preferences in the chat UI.

Task deadlines, time zones, reminders and repetition are configured from **设置时间与提醒** in the task panel. Electron checks due reminders while running, including after startup and resume; closing the app stops checks. The notification API may be supported even when Windows notification settings or Focus Assist suppress display. See [Task reminders](task-reminders.md) for persisted claims, recurrence rules, privacy and manual release checks.

**媒体资源库** in the sidebar shares the browser's image/video library, original-file downloads, generation details and confirmed deletion/regeneration. Regeneration uses the encrypted OpenRouter configuration through the local service; it creates a new resource and may incur provider charges. Files and generation metadata remain in the existing private data directories. See [Media library](media-library.md) for input-reference retention and legacy-resource limitations.

## Security boundary

- The local service binds only to `127.0.0.1` on a dynamically selected port.
- Desktop API routes require the generated Host value and a random HttpOnly session cookie.
- Writes also require a same-origin browser context; non-browser main-process requests retain Cookie/Host authentication. API quotas reset when the local service restarts. See [API contracts and local security](api-security.md).
- Electron renderers use `contextIsolation`, sandboxing, disabled Node integration, and a narrow preload bridge.
- Permission requests, webviews, arbitrary navigation, and new windows are denied.
- Only HTTPS external links are handed to the operating system browser.
- A production Content Security Policy is injected into local responses.
- Health responses expose only `{ "status": "ok" }`.

## Build outputs

Create the standalone runtime:

```powershell
npm run desktop:build
```

Create an unpacked Windows application:

```powershell
npm run desktop:package
```

Create the installer:

This command checks the project-local WiX compiler, prepares missing tools with checksum verification, and adds the tooling directory to its child processes' PATH. Existing tools are reused without downloading again. It then builds, packages, and records installer checksums; any failed step stops the pipeline. CI uses `node scripts/make-desktop.mjs --skip-build` after its separately validated runtime build. Version updates remain explicit.

```powershell
npm run desktop:make
```

The WiX maker produces a Chinese MSI installation wizard with a **Browse** button on the feature/destination page. Choose an application folder such as `D:\Apps\RiA`. Installation is per user; choose a writable directory. The final versioned installer is `out/make/wix/x64/RiA-<version>-x64.msi`. WiX 3.14.1 is a build dependency, downloaded from its official release with a pinned SHA-256 by `provision-wix.ps1`, into the ignored project tooling directory. Users installing the MSI do not need WiX or Node.js.

First-time WiX preparation computes SHA-256 through .NET without requiring the `Get-FileHash` cmdlet. Windows PowerShell downloads use basic parsing to avoid an Internet Explorer dependency on unattended runners. The checksum must match before extraction; an invalid cached ZIP stops the build. Cached and first-time preparation both require validation when this flow changes.

The installation directory contains application files, including the `app-<version>` subdirectory. Data, credentials and Electron browser caches still use `%APPDATA%\RiA`; selecting D: for installation does not move these. Uninstall removes MSI-owned files and shortcuts, retains user data and does not recursively erase unrelated files in the selected folder. Close RiA before upgrading; keep the chosen directory consistent between releases. To relocate an existing MSI installation, back up and uninstall first, then reinstall in the new directory under the same Windows account.

Previous Squirrel installers are a different installation system: back up, close and uninstall the old RiA installation before installing the MSI. Keep `%APPDATA%\RiA` intact to retain the workspace and encrypted settings. Do not leave both installations active. The stable MSI upgrade code must not change between releases.

For an installed smoke test, explicitly set `$env:DESKTOP_INSTALL_DIR = 'D:\Apps\RiA'`, then run `node scripts/smoke-desktop.mjs --installed`. The test uses an isolated workspace; it does not exercise your personal data.

Builds and packaging no longer change the version. Choose the version explicitly before a release: `npm run desktop:version` raises the patch number in both `package.json` and the root `package-lock.json` metadata, rejecting mismatched versions before writing. Major/minor changes remain manual and must update both root records. A failed build keeps the chosen version, so fix the failure and rebuild with that same number; do not reuse a version already distributed to users. `desktop:make` and the CI wrapper write `verification.json` beside the installer with SHA-256 checksums and explicit unverified manual acceptance checks. Direct Forge builds must run `npm run desktop:release-manifest` separately after making the installer.

The runtime's regenerable Next.js image and scoped response caches are excluded from the packaged copy. Immutable prerendered responses under `server/app` and `server/pages`, their metadata and the prerender manifest remain in the bundle; Next.js regenerates scoped cache entries from these seeds. This uses standalone output without a build adapter. `npm run desktop:verify` conservatively reserves 102 characters for the installation prefix and rejects bundle paths that would exceed the traditional 260-character Windows path limit. Prefer a short installation path such as `D:\Apps\RiA`.

This project does not configure Windows code signing or automatic updates. Windows may display an unknown-publisher warning until a signing certificate is added in a separate release process.

## Validation and CI

`npm run test:desktop` checks path isolation, fresh-database migration, idempotent migration, persistence, duplicate-memory preservation, and migration backups without downloading a separate testing package.

`npm run test:server` adds real route-handler and SQLite regression checks, including authentication, tool execution logging, memory upserts, chat context, regeneration, and approval replay protection. The external AI provider is simulated; these tests do not incur API charges. See [Test coverage and local validation](testing.md).

`npm run test:desktop:smoke` boots Electron against the prepared standalone runtime and verifies:

- the renderer and preload bridge load;
- API-key data is encrypted on disk;
- authenticated desktop API requests succeed;
- requests without the desktop cookie are rejected;
- a conversation remains after the local service restarts;
- conversation search, pinning and tags survive restart; Markdown/JSON downloads from the actual management UI preserve text and private media references;
- media source/recipe metadata survives restart; the actual library UI downloads an authenticated PNG and deleting its unused result preserves the reference image;
- saved model defaults survive restart; the backup UI creates and downloads a private archive, unconfirmed restore is rejected, and confirmed restore retains media/settings across another service restart without replaying reminders;
- due task notifications are dispatched once to a recording test sink, and recurrence/claims survive service restart without invoking a model or displaying OS notifications;
- the application exits without retaining its child service.

After `desktop:package`, `npm run test:desktop:package` repeats the smoke test against the actual packaged executable. `npm run desktop:verify` checks runtime resources, Prisma's native engine, migrations, EXE presence, and absence of `.env` or key-shaped values.

GitHub Actions runs the web validation and a separate Windows desktop job. The desktop job provisions the pinned WiX compiler, builds the runtime, creates the MSI installer, smoke-tests the packaged application, and uploads the MSI and checksum record.

## Troubleshooting

If startup fails, inspect:

```text
%APPDATA%/RiA/data/logs/desktop.log
```

Migration failures keep the previous database and create a timestamped backup before applying migrations to an existing application database. Do not delete the data directory while diagnosing a failure.


## Offline use, proxies and resume

Startup, persisted conversations, tasks, local document retrieval and backups do not require a model endpoint. Calling a model still requires its provider and credentials; lack of internet must not silently replace it. The explicit outbound proxy overrides inherited HTTP/HTTPS proxy values. Loopback service requests bypass it; changing desktop settings restarts the service to apply the proxy. Environment `NO_PROXY` rules remain effective.

A resume event performs a bounded loopback health check. A healthy service gets its session cookie refreshed before reminder polling; an unhealthy captured service uses the existing serialized restart/recovery path and retains the local route. Duplicate events share one check, and delayed work cannot restart a newer service or continue after quit. An interrupted provider request is recorded as interrupted with unknown billing on startup and is never replayed automatically. A health timeout can interrupt an active call during recovery; inspect usage and original messages before retrying.

The automated smoke invokes the resume handler without physically suspending Windows. Native reminder delivery uses a recording sink. Neither proves Windows notification display or a physical sleep/wake cycle. Follow [Windows release acceptance](windows-release-acceptance.md) on a clean VM before distribution.


### Workspace appearance

The chat composer keeps a fixed text-entry height. Multiline prompts and pasted code scroll inside the input instead of moving the dock or transcript. Execution history shares the composer's centered width and stays visually quiet when collapsed. The chat header omits idle status badges and repeated mode hints; generation status, model setup errors and tool readiness feedback remain visible where needed. Only scrollable regions reserve scrollbar space, so the transparent chat window has no exposed desktop strip along its right edge.

The navigation and title bar stay fixed while each page scrolls inside the workspace. Chat messages and conversation history have separate scroll regions; the composer stays docked below the transcript. Tasks live on the dedicated **定时任务** page in the navigation, where creation works without a model, and existing completion, filtering, reminder and recurrence editing remain available. Compact chat windows expose the conversation list through a header button. Escape closes it. The conversation rail animates its width and fades its content; reduced-motion preferences disable these transitions. Reload restores the saved light/dark theme before painting; without a saved preference, the initial theme follows the system. Execution history defaults to a collapsed group, with individual run details inside it; polling and status updates continue while collapsed.

Windows uses a frameless transparent native window with custom caption controls. Only the upper chat canvas is translucent, with an 88% opaque neutral background. The navigation, title bar, recent conversations, composer dock and every other page are opaque. Windows 11 22H2 and newer additionally request native Acrylic; Windows 10 and earlier Windows 11 retain the stronger neutral transparency because Electron's native material API is unsupported there. CSS blur only applies to app layers and cannot blur the desktop on those systems. Other platforms retain an opaque native backdrop. Verify dragging, resizing, maximize/restore, caption clicks and readable contrast on target machines before distribution. See [Electron native material support](https://www.electronjs.org/docs/latest/api/base-window#winsetbackgroundmaterialmaterial-windows).


Conversation actions appear on hover or keyboard focus (always visible on touch devices). Tasks expose status filters, completion checkboxes and inline reminder editing; the new-task action opens an independent form with deadline, time zone and recurrence. Completion shows immediate feedback and reverts to the last server status on a failed save. Initial loads show skeletons; refreshing the same list retains its rows. Saved rail widths are applied before hydration. Scrollbars live inside panels and appear when content exceeds the viewport; a home page that fits does not need a scrollbar. Thumb contrast is strengthened for both themes.
