# External tools and extension management

RiA's **Settings → Extensions** section connects external tools without rebuilding the application.
Built-in tool IDs, assistant snapshots and the existing approval flow remain valid.
The **My extensions** tab manages connections. **Discover extensions** browses the official MCP
Registry and prepares connection drafts; it does not install packages or load
DSH/Cordis plugins.

**Plugin marketplace** searches skills.sh for community Skills with preview and direct
installation, alongside bundled RiA packages combining instructions and optional
connections. Import, install, enable/disable and uninstall them from the same
manager; see [RiA plugin packages](plugin-packages.md). Standalone connections
and official MCP discovery remain available.

## Discover extensions

Open **Settings → Extensions → Discover extensions**. The first page loads only when this tab opens.
Search matches server names (use a service name or English keyword). The bounded,
keyboard-focusable result panel scrolls independently of the page. Scrolling down
near its bottom reads one more page without replacing loaded entries or moving
the search controls. Opening the tab reads only the first page; staying still or
scrolling up does not fetch more. The small **Scroll to load more** footer also supports
explicit activation when using a keyboard or when a page has too few entries to
overflow. Only one page request runs at a time, failures wait for **Retry**, and a
new search returns the panel to the top. New rows use the existing transition
tokens and respect reduced-motion preferences. Search
submission, paging and detail reads can be cancelled by a newer search, closing
the detail sheet or leaving the tab. A failed request provides an explicit retry;
existing configured connections remain usable.

**View details** opens an animated sheet with the publisher's description, exact
version, update date, repository/website, remote transports and local package
information. Registry inclusion is not a promise that the server implements a
compatible schema, supplies credentials or supports RiA's tool constraints.
Deleted/malformed entries are skipped; deprecated versions cannot be added from
discovery. Descriptions render as plain text and external links are restricted to
HTTP(S) URLs without embedded credentials. Browsing never probes a listed endpoint.

For a supported static Streamable HTTP address, **Add connection** opens the existing
configuration sheet with its name, endpoint and supported request-header fields
prefilled. Secret values and unresolved header placeholders are left empty; fill
the complete required header value (including an authentication prefix if needed).
Optional empty header fields are omitted. Review and save the draft, then detect
the connection, review the returned tools and explicitly enable them. Saving or
viewing a registry item never enables tools or bypasses per-call approval.
Connections with the same address can represent different accounts; an existing
address is indicated but does not prevent adding another configuration.

Local packages, SSE-only endpoints, templated/query-bearing URLs and unsupported
header configurations explain their requirements instead of running installation
commands. Use the project's instructions and existing manual connection editor
when applicable. OAuth sign-in and package/runtime installation remain unsupported.

The local service reads only `https://registry.modelcontextprotocol.io` using the
[official Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/generic-registry-api.md):
latest-version search and cursor pagination, then pinned-version details. Requests
use the existing outbound proxy configuration, omit workspace/provider credentials
and reject redirects. Each response is limited to 1 MiB and 10 seconds. Successful
pages/details are cached in memory for one hour, up to 64 entries, following the
[Registry aggregator guidance](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/registry-aggregators.mdx).
Failures and cancelled requests are not cached or automatically retried. Search
text is sent to the official registry when it is not cached locally. The cache is
optional and disappears on service restart; connection configuration remains in
the existing SQLite store. No migration, new account or new environment variable
is required.

## DSH marketplace compatibility

DSH catalogs can supply discovery metadata, but a DSH bundle is not an MCP server.
The [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
loads `dsh.bundle` patch files into a Cordis context and a DSH profile. RiA does
not provide that runtime, its UI extension points or its package lifecycle.
The [cordis.run public index](https://github.com/web-casa/Awesome-DeepSeek-Harness-Plugins/blob/main/data/plugins.json)
was readable during compatibility investigation; its timestamp must be checked
before treating it as current. RiA's discovery tab continues to use the official
MCP Registry only, with no DSH catalog source added.

An external MCP bridge can expose a DSH catalog or selected DSH tools to RiA.
An isolated source-build check of the third-party
[deepseek-harness-plugin-mcp](https://github.com/bobleer/deepseek-harness-plugin-mcp)
version `0.1.0` used RiA's actual `probeConnection` and `callConnection` functions.
Both stdio and Streamable HTTP discovered 15 tools and completed the read-only
`dsh_plugin_status` call. Install/runtime permissions stayed disabled; no DSH
runtime or plugins were installed or started. The upstream HTTP service raised
a recursive `transport.onclose` / `server.close` error during shutdown, so that
mode is not a clean compatibility pass. Stdio completed discovery, status calls
and child cleanup. The package's npm endpoint returned 404 during this check;
do not assume its README's `npx` installation command is currently available.

For an independently built bridge on Windows, use **Add extension → MCP · Local program**:
select the installed `node.exe` by absolute path, put the absolute `dist/cli.js`
path in the JSON argument array, choose the bridge's absolute working directory,
and explicitly grant process permission. Detect, select only the needed tools
(start with `dsh_plugin_status`) and enable the connection. Keep installation and
runtime flags off for an initial test. This requires the desktop runtime and an
external Node installation, not a project dependency. DSH-backed tool execution
still requires its own DSH installation/profile and has not been verified here.
UI/theme/sidebar plugins continue to render inside DSH rather than RiA.

## Supported connections

| Connection | Configuration | Tool discovery and invocation |
| --- | --- | --- |
| MCP over Streamable HTTP | Exact HTTP(S) endpoint; optional encrypted credential headers | Initialize and list tools; selected tools use MCP `tools/call` |
| Local MCP over stdio | Installed executable's absolute path, JSON argument array, absolute working directory; explicit process permission; optional encrypted environment values | A fresh child is connected for each detection/call and closed afterwards |
| HTTP API | Exact endpoint, method, description and JSON Schema for arguments; optional encrypted credential headers | One `request` tool; GET encodes arguments in the query string, other methods send arguments as a JSON body |

Local processes are available only in the desktop runtime (and isolated tests).
On Windows the executable must be an `.exe`; launch a local JavaScript server with
the full `node.exe` path and the script path as an argument. Shells and package
installation commands are not supported. RiA does not bundle Node/Python for
third-party programs or install their dependencies. The program runs with the
user's OS permissions, **not** inside RiA's directory-grant sandbox. It receives
the MCP SDK's small default environment plus explicitly supplied values, not the
application's API keys, local access credential or encryption key. Stderr is not
forwarded into application logs. On Windows cleanup terminates the owned process
tree before releasing its process identity.

HTTP connection detection sends **HEAD**, never the configured business operation.
HTTP 405 establishes reachability only; it does not validate operation-specific
credentials or business behavior. MCP detection initializes the server and lists
tools without invoking one. Resources, prompts, OAuth sign-in, legacy SSE-only
servers, arbitrary UI plugins and DSH/Cordis plugins are not implemented here.

## Add and use a connection

1. Open Settings → Extensions → Add extension, choose the connection type and save its configuration.
2. Run Test connection. Inspect the descriptions and parameter schemas returned by the server.
3. Select the tools you need and choose Enable selected tools. New connections and newly discovered tools start disabled.
4. Use normal chat with a tool-capable model; automatic tool selection is the
   default. You can also select
   the external tools in a custom assistant template. A template grants no additional
   process, filesystem or service permissions.
5. Review each proposed external call in chat and approve or reject it. The manual
   tool endpoint cannot bypass this confirmation. Read-only hints from a server
   do not authorize automatic execution.

All call sites use the shared registry and execution pipeline. Internal tools
keep their existing input schemas and IDs. External IDs are stable, connection-
qualified provider function names shorter than 64 characters; display labels
include the connection and original tool name. Tool results and labels survive
chat reloads and uninstallation. A removed tool remains historical evidence and
cannot execute again. Assistant templates still select at most 20 tools each.

External calls share the existing run/step budget, execution records and error
handling. Each operation has a 20-second deadline with no automatic call retries.
Configuring an extension does not change model token prices or account for fees
charged separately by that external service.

## Configuration, updates and cancellation

Edits require the current revision and disable the connection until detection
succeeds again. Activation and tool selection changes invalidate pending
approvals. The approval is bound to the connection revision and exact stored
arguments; a client cannot substitute another input when approving. MCP tools
are rediscovered before execution and a changed name, description or parameter
schema refuses the call instead of spending an old approval on new behavior.

Unchanged successful detection preserves activation and selection. Changed tool
definitions disable the connection and clear selections for explicit review.
Failed detection disables activation. A later edit, deletion or detection owns
its result: an obsolete probe cannot overwrite newer configuration or resurrect
a deleted connection. Disabling, editing and deleting cancel active operations
in the current local service and prevent new calls. Cancellation cannot roll
back work an external service already accepted; check that service before
manually repeating a write.

## Credentials and persistence

Connection configuration and selected tool definitions live in the SQLite
`extensions` table. Credential headers/process environment values are encrypted
with AES-256-GCM and bound to the connection ID. Management APIs return a presence
flag, never saved credential values. Known credential values are redacted from
tool results before persistence; failures report bounded generic diagnostics.
Keep secrets out of URLs, arguments, descriptions and parameter schemas.

Electron keeps the wrapping key in its existing settings file, encrypted through
OS `safeStorage`, and passes the decrypted key only to the local service. Browser
development can explicitly supply `RIA_EXTENSION_KEY` as a stable Base64-encoded
32-byte key; see `.env.example`. Without encryption, credential-free connections
remain usable and saving credentials fails closed. Losing or changing the key
requires re-entering credentials. Changing an endpoint or executable identity
clears old credentials unless replacement values are explicitly supplied.

If the OS-protected wrapping key cannot be read, the application opens with
extension credential encryption unavailable and retains the original encrypted
key. Restore the original Windows profile/settings when possible. To deliberately
reset it, close RiA, copy the encrypted settings file for recovery, remove only its
`encryptedExtensionKey` field and restart; then enter extension credentials again.
Existing credential ciphertext cannot be recovered with the newly generated key.

## Local management API

All routes use the existing local session, Host/Origin and restore gates.

| Request | Behavior |
| --- | --- |
| `GET /api/extensions/registry?search=...&cursor=...` | Latest-version official metadata, 20 entries per requested page; returns `items`, `nextCursor`, `skipped`, `fetchedAt` |
| `GET /api/extensions/registry/detail?name=...&version=...` | Normalized details for the exact listed server/version; does not connect to the server |
| `GET /api/extensions` | Public connection metadata and configured/available credential flags; no saved credential values |
| `POST /api/extensions` | Save `name`, `config` and optional `credentials`; returns an inactive connection |
| `PUT /api/extensions/:id` | Replace configuration using its current `revision`; disables the connection |
| `POST /api/extensions/:id/test` | Detect using `{ "revision": 1 }`; returns the current tool definitions and new revision |
| `PATCH /api/extensions/:id` | Set `{ "revision": 2, "enabled": true, "tools": ["echo"] }` using discovered tool names |
| `DELETE /api/extensions/:id?revision=3` | Delete only that revision; uses the existing bodyless DELETE contract |

Registry reads share a separate 30-request-per-minute quota. Duplicate or unknown
query parameters, search text over 100 characters, cursors over 2048 characters
and unpinned detail versions are rejected. Responses use `Cache-Control: no-store`;
the bounded one-hour server cache is independent of browser caching.

Writes and detection share 30 attempts per minute. Configuration JSON is capped
at 128 KiB, activation at 16 KiB and detection at 1 KiB. Revision mismatches return
409; callers must read current state and review it before retrying.

Portable workspace archives exclude connections and credentials. Restore retains
machine-local configuration but disables connections and invalidates prior tests
and approvals in the same database transaction. Detect and enable connections
again deliberately. The migration only adds a table; existing workspace rows
are preserved. Older releases do not understand external tools, so use the
pre-upgrade workspace snapshot when rolling back to a previous application build.

## Bounds and protocol limits

Up to 20 connections, 64 discovered tools per connection and 32 enabled external
tools in total are supported. Input schemas must be JSON object schemas, at most
16 KiB and 16 nested levels. Reference keywords and regular-expression schema
rules are rejected; schemas outside the supported subset fail detection visibly.
Wire responses/messages are capped at 512 KiB; retained results above 32 KiB become
explicitly truncated text excerpts. Plain text and JSON/MCP result envelopes are
shown in existing tool details; external images are not imported as RiA media.

HTTP endpoints cannot contain credentials, query strings or fragments. Calls are
restricted to the configured origin/path and redirects are rejected. Localhost
and private endpoints are intentionally allowed because users explicitly add
local services. Server-provided OAuth endpoints, arbitrary URLs from model inputs
and inherited application authentication are not used.

## Validation

The existing CI globs discover `tests/server/extensions.test.ts`,
`tests/server/extension-registry.test.ts`, `tests/e2e/extensions.spec.ts` and
`tests/e2e/extension-discovery.spec.ts`. Registry tests cover fixed-host requests,
secret/header handling, invalid/removed entries, exact-version identity, cache
expiry/eviction, failures, response limits, timeouts, cancellation, query validation
and local access/quotas. Browser tests consume official-shaped Registry responses
through the real server adapter using the isolated offline HTTP fixture. They cover
search, paging, details, unsupported transports, drafts, required credentials and
the full add/detect/enable/approve flow against an actual loopback MCP server.
Screenshots are saved outside the repository under the temporary `ria-registry-qa`
directory. The Browser plugin is unavailable; these checks use Playwright.
Server tests also use actual isolated HTTP/MCP services
and a local stdio program, including cancellation, definition changes, credential
handling, process cleanup, bounded responses and a real operation deadline.
Browser tests cover configuration, tool selection, approval/rejection, restart,
uninstallation, narrow layouts, draft validation and failed-detection recovery.
Model replies are deterministic offline fixtures; this does not establish tool
selection quality with live models or compatibility with every third-party server.
