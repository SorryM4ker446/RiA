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

The main process chooses an available loopback port, applies SQLite migrations, starts Next.js, waits for `/api/health`, sets a random HttpOnly desktop-session cookie, and then opens the window. Closing the application stops the child service.

For browser-only UI work backed by the desktop development database:

```powershell
npm run desktop:dev:web
```

This browser-only command intentionally runs in web runtime mode and therefore does not exercise Electron IPC or the desktop-session boundary.

## API keys and settings

Open the Settings page from the chat header. OpenRouter and Tavily keys are encrypted by Electron `safeStorage`, which uses Windows DPAPI. The renderer receives only boolean “configured” state and cannot read decrypted values.

Saving settings restarts the local Next.js service so that server-only environment variables are refreshed. Plaintext API keys are not written to SQLite, normal logs, the standalone runtime, or the installer.

The settings page also supports an outbound HTTP proxy, OpenRouter site name, and HTTP referrer. Chat and media model choices remain conversation-scoped preferences in the chat UI.

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

```powershell
npm run desktop:make
```

The Squirrel maker produces a versioned `Private AI Assistant-<version> Setup.exe`, a `.nupkg`, and `RELEASES` under `out/make/squirrel.windows/x64/`.

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
- the application exits without retaining its child service.

After `desktop:package`, `npm run test:desktop:package` repeats the smoke test against the actual packaged executable. `npm run desktop:verify` checks runtime resources, Prisma's native engine, migrations, EXE presence, and absence of `.env` or key-shaped values.

GitHub Actions runs the web validation and a separate Windows desktop job. The desktop job builds the runtime, creates the Squirrel installer, smoke-tests the packaged application, and uploads installer artifacts.

## Troubleshooting

If startup fails, inspect:

```text
%APPDATA%/Private AI Assistant/data/logs/desktop.log
```

Migration failures keep the previous database and create a timestamped backup before applying migrations to an existing application database. Do not delete the data directory while diagnosing a failure.
