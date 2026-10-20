# RiA

A local-first desktop AI agent with knowledge, tools, and plugins.

RiA brings streaming chat, document retrieval, and tool execution into a Windows desktop workspace. Tool-capable models can select tools and work through multiple steps, with execution records, directory permissions, and approval controls.

Conversations, knowledge, attachments, and workspace settings are stored locally. Model, embedding, search, and connector requests send the content needed for that operation to the configured service.

Built with Electron, Next.js, Vercel AI SDK, Prisma, and SQLite.

## Capabilities

| Area | What you can do |
| --- | --- |
| Chat and assistants | Stream multi-turn conversations, use built-in or custom assistant templates, attach images/PDF/Word documents, and search, tag, archive or export history. [Templates](docs/assistant-templates.md) · [Conversations](docs/conversation-management.md) |
| Knowledge | Import PDF, DOCX, Markdown and TXT with preview and confirmation; use local keyword or optional semantic + BM25 hybrid retrieval, versioned citations, index maintenance and retrieval evaluations. [Knowledge library](docs/document-knowledge.md) |
| Documents | Preview and edit extracted text; export Markdown, TXT, HTML or DOCX; read and convert documents through chat tools. [Document processor](docs/document-processor.md) |
| Agent tools | Let the model select tools automatically or request a one-shot explicit action; inspect tool inputs, outputs, steps, failures and execution limits. [Execution records](docs/execution-history.md) |
| Terminal and files | Authorize folders and use one general PowerShell tool for file management, editing and development commands, with live output and stop controls. Every command requires human approval. [Terminal tool](docs/terminal-tools.md) |
| Plugins and Skills | Discover official MCP Registry servers and skills.sh community Skills, or import RiA packages combining Skill instructions with MCP/HTTP connections. [Plugins](docs/plugin-packages.md) · [Connections](docs/extensions.md) |
| Models and media | Use OpenRouter or direct DeepSeek chat, maintain a provider-aware model allowlist and defaults, review usage estimates, and generate images/videos through supported OpenRouter models. [Models and usage](docs/model-usage.md) · [Media library](docs/media-library.md) |
| Tasks and topics | Manage time zones, recurring tasks and due reminders; organize knowledge topics and generate reports, plans or summaries with saved evidence. [Reminders](docs/task-reminders.md) · [Knowledge topics](docs/knowledge-topics.md) |
| Local workspace | Back up and restore workspace data, manage media storage, and keep desktop API keys in the system-encrypted store. [Backups](docs/workspace-backups.md) · [Storage](docs/media-storage.md) |

The interface supports light/dark themes, compact management views, keyboard navigation and reduced motion. Windows includes a translucent chat canvas, window transitions and a theme-aware startup animation.

The interface defaults to Simplified Chinese. Use **Settings → Application → Interface language** to switch between English and Simplified Chinese. Changes apply immediately without restarting or clearing drafts. Desktop preferences persist in the device's settings file across launches; the browser version saves the preference locally and synchronizes it across tabs. This setting affects interface text and date/number formatting only. Model replies follow the language of the latest user message, or an explicit request for another language; existing messages and user content are preserved.

## Start using RiA

1. Install the Windows x64 `RiA-<version>-x64.msi` produced by the [build instructions](#build-an-installer). The installed application does not require a separate Node.js installation or database server.
2. Open **Settings** and configure OpenRouter or DeepSeek. OpenRouter is required for the supported image, video and embedding features. Provider search works without Tavily, which is an optional fallback.
3. In **Models & usage**, add models to **My models** and select a default chat model. Agent tool use and on-demand community Skill reading require a tool-capable model.
4. Start a conversation or apply an assistant template. Image, PDF and Word (`.docx`) attachments are available in chat. Documents are parsed for the conversation without being added automatically to the knowledge library. [Chat attachments](docs/media-storage.md#pdf-and-word-in-chat)
5. To build a reusable knowledge library, open **Knowledge**, preview an import and confirm saving. Keyword indexing is local; semantic indexing is optional and sends snippets to the selected embedding provider.
6. Open **Extensions** for Skills, plugin packages and tool connections. Grant local folders through **File permissions** to the left of **Execution records**, or through Settings, then explicitly enable terminal access. Approve or reject each operation in the compact card above this toolbar; expand **View details** to review its command or parameters. Approval cards disappear after a decision; reasoning stays expanded unless you collapse it, without reopening or collapsing on approval. **Execution records** retains the request's execution stages, full tool details, sources and diagnostics in one entry. Web Search result counts are chosen by the model; RiA has no per-turn result-count quota, while provider API limits still apply.

Settings use four categories: **Services & models**, **Application**, **Automation & notifications**, and **File permissions**. Under **Automation & notifications**, choose **Add schedule** to configure a schedule in a side panel. Execution history, local fact reviews and reminders have their own sections; detailed rules expand on demand. Switching categories preserves unsaved inputs.

Stored history, local keyword retrieval and manual task management remain available without a model service. Generation, remote search and external connectors need their configured services. Desktop reminders and scheduled work require RiA to remain running.

## Extend RiA

- **Community Skills:** open **Extensions → Plugin marketplace → Discover skills**, search, inspect the instructions and files, install, then enable the package under **My extensions → My plugins**. Relevant text resources are loaded on demand during chat.
- **MCP and HTTP tools:** discover a server through **Discover extensions**, or configure a Streamable HTTP MCP, local stdio MCP or HTTP API connection manually. Supply required credentials, detect the connection, review its tools and explicitly enable them.
- **RiA plugin packages:** import a `.ria-plugin.json` file or paste its manifest, review the preview, install, configure its connections and enable it. Packages can combine Skills with MCP/HTTP connections; disabling or uninstalling preserves historical conversations and results.

Installing a Skill adds instructions and reference files. It does not install required software, execute bundled scripts or grant file access. Local MCP processes require separate consent and an installed runtime. Tool allowlists, directory permissions and per-call approvals still apply. The terminal runs a fresh non-interactive process for each command.

Automatic plugin updates and rollback are not implemented. RiA does not execute arbitrary Claude or DSH plugin runtimes. See [plugin formats, compatibility and limits](docs/plugin-packages.md) and [connection setup](docs/extensions.md).

## Development

Use Windows x64 for desktop packaging. Development and CI use Node.js **24.9.0** and npm **11.19.1**.

```powershell
npx --yes npm@11.19.1 ci
npm run db:generate
npm run desktop:dev
```

Electron starts and stops the local Next.js service as a child process. Configure credentials through desktop Settings; no application account is required.

For a browser-based development/test loop, run `npm run dev`. This prints a one-time local entry link and uses `.desktop-data/dev/app.db` by default. The browser server is a development tool; the supported delivered application is the Windows desktop build.

Keep `.npmrc` and `vendor/` when installing dependencies. Reviewed local dependency backports and their maintenance requirements are documented in [vendor/README.md](vendor/README.md). After dependency changes, run `npx --yes npm@11.19.1 audit --audit-level=low` and the relevant regression checks.

Local API requests enforce access credentials, Host/Origin checks, input limits and quotas. See [API security](docs/api-security.md), [local API contracts](docs/local-api.md) and [model catalog maintenance](docs/model-catalog.md).

## Build an installer

```powershell
npm run desktop:make
```

This prepares WiX, builds the desktop runtime and packages the application into a versioned MSI with SHA-256 verification metadata:

```text
out/make/wix/x64/RiA-<version>-x64.msi
out/make/wix/x64/verification.json
```

The installer supports choosing the program directory; installed workspace data lives under `%APPDATA%\RiA` by default. Changing the program directory does not move the workspace.

For a new version, run `npm run desktop:version` once before building. It synchronizes `package.json` and the lockfile; builds do not increment the version automatically.

| Command | Output |
| --- | --- |
| `npm run desktop:build` | Verified standalone runtime in `.desktop-runtime/` |
| `npm run desktop:package` | Unpacked Windows application in `out/RiA-win32-x64/` |
| `npm run desktop:make` | MSI and verification metadata in `out/make/wix/x64/` |

CI builds and validates the Windows package but uploads failure diagnostics only, rather than installers. Windows code signing and automatic application updates are not configured. Building or smoke-testing an MSI does not establish that clean installation and upgrades have passed. See [desktop development and release](docs/desktop.md) and [Windows release acceptance](docs/windows-release-acceptance.md).

## Validation

`npm test` runs the configured type, lint, schema, server, desktop, diagnostic and browser checks. Individual checks include:

```powershell
npm run lint
npm run typecheck
npm run test:server
npm run test:db
npm run test:desktop
npm run test:e2e:diagnostics
npm run test:e2e
```

After preparing the corresponding runtime/package, validate desktop resources and startup with:

```powershell
npm run test:desktop:smoke
npm run desktop:verify
npm run test:desktop:package
```

Tests use isolated SQLite databases and deterministic external-service fixtures. They verify application behavior without proving live-provider answer quality or replacing Windows installation/upgrade acceptance. See [testing and validation](docs/testing.md).

## Data and recovery

**Backup & restore** exports workspace business data and media, and creates a safety backup before restoring. Portable archives are unencrypted and exclude provider keys and the local access credential. Plugin/connector declarations are machine-local and omitted from portable archives; restoring keeps existing local declarations but disables them and invalidates approvals. See [backup rules](docs/workspace-backups.md) and [plugin persistence](docs/plugin-packages.md#persistence-and-api).

Private media assets hold images, videos and document attachments. **Storage** provides explicit cleanup with reference protection. See [media storage](docs/media-storage.md).

Older account-scoped databases are inventoried and snapshotted before adopting a local workspace. Data spread across several accounts requires an explicit ownership decision instead of a silent merge.

```powershell
npm run workspace:status
npm run workspace:inventory
npm run workspace:prepare
npm run workspace:restore
```

See [local workspace upgrade and recovery](docs/workspace-upgrade.md) for the migration and restore procedure.

## Project layout

| Path | Responsibility |
| --- | --- |
| `electron/` | Main process, preload bridge, settings, migrations and desktop security |
| `src/app/` | Pages and local API route handlers |
| `src/features/chat/` | Chat views, API client and conversation/media/tool hooks |
| `src/lib/chat/` | Validated requests, context, streaming and persistence |
| `src/tools/` | Shared tool registry, descriptors and execution |
| `src/lib/documents/` | Extraction, indexing, retrieval and document processing |
| `src/lib/plugins/` | Plugin packages and community Skill integration |
| `src/lib/extensions/` | MCP/HTTP connections and official Registry discovery |
| `src/lib/memory/` | Memory storage and retrieval policies |
| `src/db/` | Prisma schema and SQLite migrations |
| `scripts/` | Development, migration, packaging and validation utilities |
| `tests/` | Server, browser and desktop regression coverage |
