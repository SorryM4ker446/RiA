# External tools and extension management

RiA's **扩展管理** page connects external tools without rebuilding the application.
Built-in tool IDs, assistant snapshots and the existing approval flow remain valid.
This page manages connections; it does not install packages or provide a plugin market.

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

1. Open 扩展管理 → 添加扩展, choose the connection type and save its configuration.
2. Run 检测连接. Inspect the descriptions and parameter schemas returned by the server.
3. Select the tools you need and choose 启用所选工具. New connections and newly discovered tools start disabled.
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
| `GET /api/extensions` | Public connection metadata and configured/available credential flags; no saved credential values |
| `POST /api/extensions` | Save `name`, `config` and optional `credentials`; returns an inactive connection |
| `PUT /api/extensions/:id` | Replace configuration using its current `revision`; disables the connection |
| `POST /api/extensions/:id/test` | Detect using `{ "revision": 1 }`; returns the current tool definitions and new revision |
| `PATCH /api/extensions/:id` | Set `{ "revision": 2, "enabled": true, "tools": ["echo"] }` using discovered tool names |
| `DELETE /api/extensions/:id?revision=3` | Delete only that revision; uses the existing bodyless DELETE contract |

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

The existing CI globs discover `tests/server/extensions.test.ts` and
`tests/e2e/extensions.spec.ts`. Server tests use actual isolated HTTP/MCP services
and a local stdio program, including cancellation, definition changes, credential
handling, process cleanup, bounded responses and a real operation deadline.
Browser tests cover configuration, tool selection, approval/rejection, restart,
uninstallation, narrow layouts, draft validation and failed-detection recovery.
Model replies are deterministic offline fixtures; this does not establish tool
selection quality with live models or compatibility with every third-party server.
