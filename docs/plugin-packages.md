# RiA plugin packages

Plugins combine reusable skill instructions with optional MCP/HTTP connections.
Existing standalone connections, MCP discovery, tool allowlists and approvals remain.

## Use and lifecycle

**扩展管理 → 插件市场 → 发现 Skill** searches the public skills.sh directory.
Enter at least two characters (for example `writing` or `react`), press **搜索**,
then **查看详情** to read `SKILL.md`, inspect bundled files and check compatibility.
Press **安装技能** and enable the installed package in **我的扩展 → 我的插件**.
For example, search `vercel-react-best-practices`, select the entry from
`vercel-labs/agent-skills`, install and enable it, then ask the assistant to review
a pasted React component for performance issues. A tool-capable chat model can
load the relevant guidelines and rule files. This does not grant access to the
project on disk: local files still require the existing directory grant.

The directory returns up to 30 matches per explicit search, with public install
counts. Currently only GitHub `owner/repository` sources with downloadable textual
snapshots are supported; unsupported results are counted, not silently installed.
Some indexed skills have no snapshot and return an actionable unavailable message.
The API is the same search/download surface used by the official
[skills CLI](https://github.com/vercel-labs/skills/blob/main/src/blob.ts), rather
than a mirrored marketplace or a bundled copy of its catalog.

The **RiA 精选插件** section retains the bundled catalog. Search by name/purpose,
inspect skills and connections, then **安装插件**. Browsing
and installation never detect services or execute business calls. New packages
start disabled in **我的扩展 → 我的插件**. Skill-only packages can be enabled
immediately. Combined packages require configuration, successful connection
detection and explicit tool selection before package activation. Credentials
remain in the existing encrypted connection store, outside the package manifest.

Enabled bundled skills enter subsequent normal chat requests as bounded task guidance.
Community skills instead contribute a compact index (name, purpose, package ID
and snapshot identity). The internal `readPluginSkill` tool loads `SKILL.md` and
selected references on demand, with 12,000-character pages and explicit continuation
offsets. It is absent from the manual tool picker and template capability list;
reading enabled guidance cannot bypass assistant tool restrictions. The complete
downloaded files are saved in the package manifest in the local SQLite database,
not truncated to the inline instruction limit or written to executable folders.
Reading installed files works offline and rechecks package enablement each call.
The original SKILL.md (including full frontmatter, license and dependency notes)
is preserved and visible, even when a list description is shortened.

Community snapshots provide guidance and read-only text resources. Scripts are
preserved as references, never launched, and required runtimes, accounts, browsers
or services are not auto-installed. Skills requiring those capabilities can only
complete the parts supported by the configured RiA tools; the assistant must report
missing capabilities. Installing a Skill does not install an MCP connection or
arbitrary Claude/DSH plugin runtime. A model without tool support cannot load these
on-demand files.
The model applies relevant skills without gaining any additional permissions.
Tool allowlists, directory grants, schema checks, budgets and per-call external
approval remain enforced. Image/video modes do not load these chat skills.
This adds guidance, not a guarantee of model instruction-following quality.

**停用插件** blocks its tools, cancels active operations, invalidates approvals and
removes skills from subsequent chat context. Reviewed tool selections remain for
reactivation. Text already sent upstream cannot be retracted. An unavailable or
reconfigured connection suppresses the combined package's guidance until all its
connections are ready again. **卸载插件** atomically removes the package, its owned
connections and encrypted credentials; unrelated connections, chats and historical
results remain. Owned connections must be removed through package uninstall.

## Import format

**导入插件** accepts `.ria-plugin.json` files or pasted JSON. **预览插件** validates
without writes/execution. Installation revalidates the normalized content and
SHA-256 digest; draft edits invalidate previews. A digest identifies content, not
publisher trust. Author fields are self-declared. Ready-to-import examples:

- [Writing skill](examples/writing.ria-plugin.json)
- [Skill + Context7](examples/library-docs.ria-plugin.json), using the provider's
  [published endpoint and authentication setup](https://github.com/upstash/context7#installation).

Required manifest fields: `format: "ria-plugin"`, `schemaVersion: 1`, unique `id`,
`name`, semantic `version`, `author`, `description`, and at least one skill or
connection. Skills have unique `id`, `name`, `description`, Markdown `instructions`.
Connections have unique `id`, `name`, existing extension `config`, and optional
credential declarations (`key`, `required`, `description`); values are rejected.
HTTP configs use `type: "http"`, exact `url`, `method`, `description`, object
`inputSchema`; detection remains HEAD-only. MCP uses existing Streamable HTTP or
stdio contracts. Overrides stay separate from the immutable manifest.

Local programs need separate process consent, installed executables and absolute
paths; they are desktop-only. There is no runtime download, npm/shell installer,
archive extraction, remote URL import, SKILL.md directory import, arbitrary
JavaScript/hooks or third-party plugin-runtime execution. Adapt skill instructions
to this format; bundled scripts are not executable plugin components.

Limits: 2 MiB normalized package/request (plus the install envelope allowance),
256 snapshot files, 500,000 characters per file, 12 installed packages,
8 skills/4 connections per package,
6,000 instruction characters per skill, 12,000 per package, 24,000 across enabled
packages. Existing bounds remain: 20 connections, 32 selected tools, 64 tools per
connection. Duplicate package IDs/versions are rejected; uninstall to replace a
version. Automatic upgrades/rollback are not implemented.

## Persistence and API

Migration `20261018120000_plugin_packages` adds machine-local `plugin_packages`
and nullable ownership on `extensions`; existing standalone IDs/settings/states
remain intact. Startup migrations create a safety backup and run once. Install
and uninstall are SQLite transactions. Older app versions must not manage new
packages. Portable archives omit packages/connections; restore retains their local
declarations but disables both and invalidates approvals. Detect and activate again.
Keep source JSON separately to move packages to another machine.

- `GET /api/plugins`: installed packages and bundled catalog, no-store.
- `GET /api/plugins/skills?q=...`: skills.sh search, local access, no-store.
- `GET /api/plugins/skills?repository=owner/repo&skill=slug`: download/validate
  snapshot and return the existing install preview (`manifest`, `digest`).
- `POST /api/plugins/preview`: manifest → normalized manifest/digest.
- `POST /api/plugins`: `{manifest,digest,allowLocalProcesses?}` → inactive install.
- `PATCH /api/plugins/:id`: `{revision,enabled}` → state change.
- `DELETE /api/plugins/:id?revision=...`: uninstall and remove owned connections.

Routes retain local access, Host/origin policy, restore exclusivity, bounded bodies
and the shared extension mutation quota. Lifecycle writes require current revisions.
Tests cover validation, atomicity, ownership, bounds, credentials, real chat context,
HTTP/MCP approval, cancellation, restart, uninstall, migration and restore. Browser
acceptance includes dark/light, narrow layouts and reduced motion. Services/model
replies are deterministic fixtures, not live service/model-quality validation.

Marketplace requests use a fixed `https://skills.sh` origin with only its exact
apex-to-`www.skills.sh` redirect allowed. They omit cookies, provider keys and
connection credentials, have a 15-second timeout, bounded streamed responses,
request cancellation and a separate 30/minute quota. No git, npm, shell or installer
subprocess runs. Search/details perform no database writes. Installation uses the
exact previewed snapshot and existing digest check and atomic lifecycle; it does
not silently fetch newer content. Reinstall requires uninstalling the old package.
The upstream `hash` is retained as an opaque snapshot identifier; an independently
computed SHA-256 `contentHash` binds sorted file paths and full contents, while
the package digest covers metadata too. These are integrity identifiers, not a
publisher signature. Safe relative paths, unique filenames, required entrypoint
and bounded YAML frontmatter are validated; aliases, duplicate YAML keys and
unsupported binary files are rejected before installation. The manifest's optional
`marketplace` object is backward compatible with existing `.ria-plugin.json` packages.
