# Desktop terminal tool

RiA provides one general terminal tool, `runTerminalCommand`, for non-interactive Windows PowerShell commands. It replaces the separate directory-listing, file-reading and new-file tools. The model receives current authorized folder IDs and canonical paths and chooses commands for the user request. File creation, reading, editing, search, copying, moving, renaming, deletion and installed development tools are examples, not an operation allowlist.
It uses the same tool registry, assistant tool restrictions, approval workflow
and execution records as other chat tools. It is unavailable in the web runtime.

## Enable and use

1. Open **文件权限** to the left of **执行记录** above the chat composer (or
   **Settings → File access**), choose
   a working folder and explicitly grant access. Choosing a folder alone does
   not authorize it. These machine-local permissions apply across conversations.
2. Choose **开启终端** for that folder, choose **审批** or **完全访问**, and
   confirm the separate terminal permission. **审批** (the default) requires an
   approve/reject decision for every terminal tool call. **完全访问** runs LLM
   terminal commands without per-call approval. Each call may contain a complete
   script; approval covers the whole call rather than individual script statements.
3. In a conversation with a model that supports tools, ask for a command, for
   example: “在已授权的项目目录运行 `Get-ChildItem`，列出文件并解释结果。”
4. In **审批** mode, review the compact approval card above the **文件权限 / 执行记录** toolbar. Its default view shows the operation, canonical working directory and approve/reject controls. Choose **查看详情** to expand the exact command in a bounded scroll area, then **收起详情** to collapse it. Expansion follows the shared motion tokens and respects reduced motion. **执行详情** opens the corresponding execution record; full commands, inputs, outputs, status, sources and diagnostics remain there. Execution records do not open automatically. Each call needs its own decision; queued approvals are presented one at a time and each new item starts collapsed. In **完全访问** mode execution starts automatically and the same execution records remain available.
5. Open **执行详情** to see live stdout, stderr and the exit code. Use
   **停止命令** to stop a long command. Stopping the chat request, cancelling its
   execution record, changing terminal mode, disabling permission or revoking the folder also
   stops the associated command.

Choose **终端：审批** or **终端：完全访问** beside a folder to change its mode.
Mode changes invalidate pending commands as well as stopping running ones, so a
command proposed under an older permission must be requested again. The mode is
machine-local, applies across conversations, and survives app restart. Existing
terminal grants retain **审批** after upgrading; full access is never enabled by
the migration. Disabling, re-granting or restoring resets the mode to **审批**.

Approval continuations retain their server-issued run identities in the saved assistant message and appear as one request in execution records. Existing messages with one `runId` remain supported. Legacy rows without a link are joined only when one user-message window contains exactly one run and one saved assistant reply; ambiguous histories are not matched by title. Missing full details are labeled explicitly and existing step summaries remain expandable. No database migration or replay of old commands is needed.

Text/tool answer upserts in `saveChatMessage` save their complete command inputs, outputs
and pending approvals in one database batch, together with media-reference
cleanup and summary invalidation. The write does not keep an interactive
transaction open while a large message crosses the Prisma boundary. This avoids
its default five-second expiration rolling back a completed command's answer or
the next pending approval. Existing database acquisition and lock timeouts and
approval claim checks remain in effect. Persistence failures log
`chat.persist.failed` with a safe error code, without command or query contents.

Text-only keyed replacements bind the message body once in a parameterized
SQLite upsert, reusing the inserted value for an update. The message ID, role and
creation time remain stable on replacement; media cleanup and summary changes
remain in the same atomic transaction.

Conversations created from templates retain their tool allowlist. Add
**执行终端命令** to a custom template if needed. Legacy file-tool selections normalize to this tool, but no folder gains terminal permission automatically. Old approvals for retired file tools cannot execute; send a fresh request and review its terminal command.

## Authority and limits

Terminal permission is separate from choosing a folder and defaults to off,
including for folders granted before upgrading. Commands run as the current
Windows user. The working directory is **not a filesystem or network sandbox**;
a command can access files outside it or start programs. There is no file-extension or fixed-operation allowlist for PowerShell. Do not put credentials into commands.
The child receives an allowlist of OS environment variables, excluding RiA's
API keys, database configuration and local service credentials. This does not
prevent a command from reading files or other resources available to the user.

Executable discovery inherits `PATH`/`PATHEXT`, together with development-tool
locations such as `GOROOT`, `GOPATH`, `NODE_PATH`, NVM, Python and virtual-environment
paths, Java, .NET and Rust locations. Installed `python`, `go`, `node`, package
managers and other commands can be discovered with `Get-Command` or `where.exe`.
RiA does not install missing runtimes automatically. Restart RiA after changing
system environment variables so its inherited environment reflects those changes.
The service's `NODE_ENV=production`, `NODE_OPTIONS` and Electron Node-mode flags
are not imposed on developer commands.

Each command starts a fresh Windows PowerShell process without a profile or
interactive input. Shell variables and current-directory changes do not persist
between calls. Administrator prompts and interactive terminal programs are not
supported. There is no terminal-specific command character limit. Scripts travel
over a UTF-8 pipe rather than command-line arguments or environment variables,
avoiding Windows length limits. The chat endpoint has no request-body byte limit,
including approval continuations and later messages carrying terminal history.
It bypasses Proxy's bounded body clone and authenticates in the route before
reading the body. Other endpoints retain their existing request limits. Model
context/output capacity and available machine memory still apply. The
terminal command has no automatic time limit. New execution stages also have no
step-count, failure-count or aggregate duration cap. A command ends when its
process exits, the user stops it, the request is cancelled or permission is
revoked. Old `timeoutSeconds` approval fields remain readable but are ignored.
At most two commands run concurrently.
Combined captured output is limited to 64 KiB and is explicitly marked when
truncated. Output and command text are saved with the chat and sent to its model.
The complete command is stored in the tool input; tool results contain status,
output and file changes without echoing the script. This avoids duplicating large
commands in every saved message and continuation request. Live session responses
still include the command, and older chat results containing it remain readable.
Terminal results are not automatically saved as knowledge or memory.

A Windows Job Object stops ordinary child processes when the shell is stopped
or ends. A parent-process watcher ends the shell when the local service exits.
This is process cleanup, not a security sandbox; processes created indirectly by
external services are outside that ordinary descendant relationship.

Live session records are process-local, limited to 24 and retained for up to
30 minutes after completion. After restart the chat's persisted result remains
readable; interrupted commands never resume automatically. Restoring a portable
backup revokes directory permissions, including terminal permission, so old
approvals cannot execute against restored grants.

The isolated test runtime uses PowerShell on Windows and a non-interactive `sh`
process group on other platforms to exercise CI contracts. This does not enable
terminal execution in non-Windows production builds.

## Files changed by a reply

After the assistant finishes, **最近编辑的文件** appears below its reply when
terminal results contain detected changes. Each row shows a relative path,
created/modified/deleted status and a line-count or size summary. These are
filesystem observations rather than a model-generated description of intent.
Repeated edits in the reply are merged; creating then deleting a file leaves no
net row. Three compact rows are shown initially, with an expand control for longer lists.
Approval pauses and active generation do not display a completed change card.

Each terminal command compares working-directory snapshots before and after
execution, including failed commands and stopped commands that wrote files.
Reads and unchanged small files are omitted. Small-file contents are hashed and
UTF-8 line counts are retained, without retaining file text. Large files use
size and modification metadata. A rename appears as deletion plus creation.
Results are part of the existing tool output, so they survive chat reload,
service restart and backup without a separate store or database migration.
Older results without observations remain readable without inventing file lists.

Observation is limited to the working directory and skips junctions/symlinks,
`.git`, `node_modules`, `.next`, `.venv` and `__pycache__`. Each walk considers up
to 10,000 entries for up to 1.5 seconds; small-file hashing reads up to 8 MiB in
total and 256 KiB per file. At most 100 change rows are retained per command.
These are observation budgets, not command input or execution restrictions.
Interrupted, unreadable or truncated observations are explicitly labeled as
partial. Partial walks do not treat an unobserved file as proof of absence.
Concurrent external edits may be observed during the same window; the card is
not a forensic audit of every file touched. Changes outside the working directory
are not claimed. Revoking permission prevents a new post-command observation.

In the desktop app, clicking an existing file opens its default system
application. `POST /api/terminal/files/resolve` accepts the grant ID and relative
path, authenticates the caller, rechecks current terminal permission and canonical
containment, and returns an existing regular file's absolute path. The trusted
Electron bridge invokes `shell.openPath` only after the click. Deleted files are
disabled; moved files, revoked permissions and missing default applications show
an error without discarding the change record. The web runtime displays the
summary without offering native file opening.

Execution details retain the reviewed command, directory, output and result.
Historical standalone file-tool references remain readable in these details.
