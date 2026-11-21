# Desktop terminal tool

RiA provides one general terminal tool, `runTerminalCommand`, for non-interactive Windows PowerShell commands. It replaces the separate directory-listing, file-reading and new-file tools. The model receives the ID and canonical path of the conversation's selected workspace and chooses commands for the user request. File creation, reading, editing, search, copying, moving, renaming, deletion and installed development tools are examples, not an operation allowlist.
It uses the same tool registry, assistant tool restrictions, approval workflow
and execution records as other chat tools. It is unavailable in the web runtime.

## Enable and use

1. Open the workspace picker above the chat composer and choose **Manage folders…** (or
   **Settings → Workspace permissions**), choose
   a working folder and explicitly grant access. Choosing a folder alone does
   not authorize it. These machine-local permissions apply across conversations.
   A granted folder is one the model may work in, terminal included: there is no
   separate step to enable the terminal. The page says, where the folder is added,
   that commands run as the current Windows user and the folder is not a sandbox.
2. Select the conversation's workspace with the same picker, to the left of
   **Execution records**. See [Conversation workspace](#conversation-workspace).
3. In the composer, left of the context-usage ring, the conversation's **approval rule** says what waits for you. See
   [Approval rules](#approval-rules). Each call may contain a complete script;
   approval covers the whole call rather than individual script statements.
4. In a conversation with a model that supports tools, ask for a command, for
   example: “Run `Get-ChildItem` in the workspace, list the files and explain the result.”
5. When a command waits for approval, review the compact approval card above the **Workspace / Execution records** toolbar. Its default view shows the operation, canonical working directory and approve/reject controls. Choose **View details** to expand the exact command in a bounded scroll area, then **Collapse details** to collapse it. Expansion follows the shared motion tokens and respects reduced motion. **Execution details** opens the corresponding execution record; full commands, inputs, outputs, status, sources and diagnostics remain there. Execution records do not open automatically. Each call needs its own decision; queued approvals are presented one at a time and each new item starts collapsed. Under **Full access** execution starts automatically and the same execution records remain available.
6. Open **Execution details** to see live stdout, stderr and the exit code. Use
   **Stop command** to stop a long command. Stopping the chat request, cancelling its
   execution record or revoking the folder also stops the associated command.

## Approval rules

Whether an action waits for you is decided by the conversation's approval rule
(a task's conversation uses the task's), not by the folder or the tool. Every tool
that changes something declares one kind of action, and one table decides it
(`src/lib/approvals/rules.ts`):

| Rule | File edits (`editProjectFile`) | Terminal commands (`runTerminalCommand`) | Extension tools (MCP, HTTP) | Creating a task, saving a knowledge entry | Pictures (`generateImage`) |
| --- | --- | --- | --- | --- | --- |
| **Ask** (default) | Wait for approval of the shown diff | Wait for approval of the exact command | Wait for approval | Wait for approval | Made when your latest message asks for it, otherwise wait for approval |
| **Accept edits** | Written directly | Wait for approval | Wait for approval | Wait for approval | As under Ask |
| **Auto** | Written directly | Reviewed first; run without asking when the review allows it, otherwise wait for approval | Reviewed like commands | Wait for approval | As under Ask |
| **Full access** | Written directly | Run without asking | Run without asking | Done without asking | Made without asking |

Whether your latest message asks for a picture is judged by the same reviewer
model, from your own words only; see [pictures made in chat](media-library.md#pictures-made-in-chat).

Reading files, logs, the knowledge base or the web never asks. A question the
model asks you (`askUser`) is not an approval and waits for your answer under
every rule. Under **Full access**, extension tools can send email or data to the
services they connect to without asking; choose it only for work you trust the
model with. A new tool declares its kind of action and follows the same table.

### Auto

Under **Auto** a command, or an extension tool call, that would otherwise wait is
first put to a separate model call, an internal sub-agent: the internal sub-agent model
when one is chosen in model settings, otherwise the conversation's model (used again if
the chosen one fails). That call starts from a fresh context and sees only:

- the user's own messages in the request (the first and the latest three; how many
  were left out between them is stated, with the conversation's stored summary, up
  to 1,500 characters, standing in for them), without the reference data RiA sends
  with them. The summary is model-written and may restate material the assistant
  read; the review is told to use it only for context and never as permission;
- the workspace folder's path;
- the names of the tools whose results the assistant has read, and how often, never
  what they returned;
- the calls already made since the user's latest message (the last 20, with how many
  earlier ones were left out), each with its tool, its input without RiA's own
  bindings, whether it ran, failed or was denied, and its review decision. This list
  is written by RiA from the call records, never by a model, and holds no output. A
  review judges each action together with the others of its step and with these, so
  steps that are harmless one by one but add up (copying credentials into the
  workspace, then pushing) are caught;
- the command, its working directory and whether it runs in the background, or the
  extension, tool and arguments.

Text from a web page, file, command output or tool result therefore cannot argue
for its own action. The review answers **allow** only for work that plainly serves
the user's request and stays within reading or the workspace: building, testing,
the project's own scripts and dependencies, file changes the task calls for, local
git without pushing or rewriting history. It asks the user for anything that sends
data off the computer, deletes outside the workspace or most of it, changes the
system, reads credentials, downloads and runs code, is obfuscated, does not follow
from the user's messages, or cannot be told. A reply that is not one of those two
answers, or a failed call, waits for the user; Auto can only save an approval,
never remove one.

Commands that only read skip the review: every step of the command (split at `;`,
`|` and line breaks) starts with a reading cmdlet such as `Get-ChildItem`,
`Get-Content`, `Select-String`, `Test-Path` or `Get-Command`, or with `git status`,
`log`, `diff`, `show`, `rev-parse`, `ls-files`, `blame`, `shortlog` or `describe`,
and the command has no script block, subexpression, variable, call operator,
redirection or encoded command.

Reviews are kept few and short. The calls the model makes in one step are reviewed
together in one model call, with a verdict for each. A turn has at most one review
in flight; calls made meanwhile wait and go together in the next one. An **allow**
is reused for the same action in the same conversation while the user's request is
the same (the first and the latest of their messages) and nothing else was done in
the turn since, for up to 30 minutes: a repeated `npm test` is reviewed once, but the
same command after other steps is reviewed again with them. An **ask** is never
reused. The fixed review
rules lead the prompt, so providers with prompt caching bill them at cache rates.
Each review is billed and recorded like the conversation's other calls. A review
has 60 seconds, both models included; while it runs the reply shows "Checking this
step against your request…", and once the time is up the call waits for you.

When a review waits for the user, the approval card says why ("Auto review: ..."),
or that the review gave no answer. Execution details show the review's decision
and reason for each reviewed call, and the execution record keeps them with the
call's input. In a scheduled task a call the review does not allow waits for
approval, as under **Ask**. Older builds and older backups do not know the `auto`
rule: restoring a backup that uses it needs this version.

The rule belongs to the conversation, so two conversations in one folder can work
under different rules. Choose it with the **Approval rule** picker in the composer, left of the
context-usage ring. It is there whether or not a folder is chosen yet; before the
conversation exists it names the default a new one starts with. It applies from the next tool call, including in a tool set built before the
change, and is restated to the model with the workspace on every request.
A new conversation starts from the default in **Settings → Workspace permissions →
Approval rule for new conversations**, which is **Ask** until changed; changing the
default leaves existing conversations as they are. A task's conversation uses the
task's own rule, set in the task form ([Tasks](tasks.md#what-a-task-decides)).

Re-granting or revoking a folder still invalidates commands approved before it, so
a command proposed earlier must be requested again.

Upgrading moves approval off the folders (`20261114100000_approval_rules`): a
conversation or task working in a folder that was set to full access gets **Full
access**; everything else asks. Folders whose terminal was off become usable for
commands, which still ask under **Ask**. Older builds cannot read the changed grants
table; rolling back means restoring the backup taken before the upgrade.

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
**Run terminal command** to a custom template if needed. Legacy file-tool selections normalize to this tool. Old approvals for retired file tools cannot execute; send a fresh request and review its terminal command.

## Conversation workspace

Authorizing a folder and selecting it are separate. Authorization (**Workspace permissions**)
is a machine-wide standing permission; each conversation then selects at most
one authorized folder as its workspace in the picker above the composer. The
picker lists only active grants and offers **No workspace**. Choosing before the first message creates the conversation that
holds the choice. The choice is stored with the conversation
(`PATCH /api/conversations/:id` with `workspaceGrantId`) and applies from the
next message. It cannot change while a reply is generating, and sending waits
for a switch in progress.

The terminal and project-file tools are told only the selected workspace, never
other granted folders. Every request also restates the current workspace to the
model with the latest user message, noting that earlier tool calls in other
folders are history after a switch. Without a selection the model is told no
workspace is selected and that the user must choose one.

Execution reads the conversation's workspace when each folder tool call runs. A
call for any other folder is refused without asking for approval, and an
approval given before a switch is refused rather than running in the previous
folder; the model is told to retry in the current workspace. Withdrawing a grant
clears it as the workspace of every conversation that selected it. Like grants,
the selection is machine-local: workspace backups omit it and conversations
restored from a backup have none. Conversations from before this change start
without a workspace until one is selected.

## Authority and limits

Granting a folder is what lets commands run in it; choosing it as a conversation's
workspace is what lets that conversation use it, and the conversation's approval
rule decides what waits for you. Commands run as the current Windows user. The working directory is **not a filesystem or network sandbox**;
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
supported. The command's output is formatted inside the run (`Out-Default`), so
objects printed as a table (for example `Get-ChildItem | Select-Object Name,Length`)
reach stdout before the process exits; the exit code still follows the command
(`$?` and `$LASTEXITCODE`). There is no terminal-specific command character limit. Scripts travel
over a UTF-8 pipe rather than command-line arguments or environment variables,
avoiding Windows length limits. The chat endpoint has no request-body byte limit,
including approval continuations and later messages carrying terminal history.
It bypasses Proxy's bounded body clone and authenticates in the route before
reading the body. Other endpoints retain their existing request limits. Model
context/output capacity and available machine memory still apply. The
terminal command has no time limit unless one is named. The model may give a
command `timeoutSeconds` (up to 24 hours), meant for servers, watchers and calls
that may hang; at that limit the command and its ordinary child processes are
stopped and the result says `timed-out`, with the output so far. The limit is
part of what is approved and is shown next to "PowerShell" on the approval card
and the result. In a conversation a command without one runs until it exits or
the user stops it. In a scheduled task, where nobody can stop it, a command
without one is stopped after an hour. A command also ends when the request is
cancelled or permission is revoked. New execution stages have no step-count,
failure-count or aggregate duration cap (see [Execution history](execution-history.md)
for retries). There is no cap on how many commands run at once, background ones
included.

### Background commands

A command started with `runInBackground` returns as soon as it is under way,
with its id, while it keeps running: a dev server, a watcher, or a long build or
test run the model works beside. Approval is the same as for any command, and
the approval card and result say "In the background". Stopping the answer does
not stop it; its card stays live, with its own **Stop command**, and the call's
summary reads "Started in the background". The model follows it with
`checkTerminalCommand`, which returns the status and only the output printed
since the last check (`omittedBytes` counts what was dropped between checks,
readable through `readTerminalLog` when the result has a log reference) and can
wait up to 10 minutes for the command to end, and ends it with
`stopTerminalCommand`, which needs no approval. Both reach only the
conversation's own commands. When a background command ends before the model
has checked it, the next request's context says how it ended; commands still
running are listed there on every request. A background command ends when it
exits, is stopped, reaches its `timeoutSeconds` (in a scheduled task, the
one-hour default), its folder is revoked, its conversation is deleted, or the
app exits.
Captured output is limited to 64 KiB: the beginning of the command's output plus
the latest 8 KiB of each of stdout and stderr, so a build or test summary at the
end is kept. An explicit marker states how many bytes in between were omitted.
Output and command text are saved with the chat and sent to its model.

The model is sent less: up to 16 KiB of a command's output, the beginning and the end of
each stream, with a line where the rest was left out saying how many bytes and how to read
them (`src/lib/terminal/model-output.ts`); the card, the execution record and approvals keep
the capture. Compared with a real model on a test log whose one failure sat in the middle,
16 KiB found the failure every time with about a quarter of the input, while 64 KiB hid the
gap and the model reported no failure. Earlier results are replayed to the model the same way.

When output exceeds what the model is sent (16 KiB), its complete stdout and stderr are also saved as
a terminal log in the cache folder (`terminal-logs/<command id>`, beside the local database unless a cache folder was chosen; see [Data and cache location](data-location.md)), and the
result carries a `log` reference with byte counts and `complete`. The
`readTerminalLog` tool, available wherever `runTerminalCommand` is, reads a log
by 1-based line range (up to 400 lines and 48 KiB per call, continuing at
`nextLine`) or lists matching lines for a case-insensitive search (as many as
`lineCount` asks for, at most 50, with `nextLine` at the next match). History
records and summaries keep the reference, so later steps and requests can read
the omitted middle. Logs are bounded to 64 MiB per command and 512 MiB in total;
beyond either, or on a write failure such as a full disk, a log is marked
incomplete and the command result is unaffected. Reading requires the folder to
still be granted. A folder's logs are deleted when its permission is
revoked or re-granted; logs are also removed with their conversation,
after a workspace restore, after seven days, and oldest first beyond the total
size. Logs of commands still running are not removed for space. Logs are not part
of workspace backups.
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

## Project file tools

Wherever `runTerminalCommand` is offered, two file tools come with it, under the
same granted folder and the conversation's approval rule; they add no permission of
their own and appear in template tool lists through the terminal tool.

- `readProjectFile` reads a UTF-8 text file by 1-based line range (default 400,
  at most 2,000 lines and 64 KiB per call, continuing at `nextLine`). It returns
  numbered lines, the line-ending style, BOM and a 16-hex-digit content hash.
- `editProjectFile` replaces exact text or writes a whole file. The model passes
  the hash from its read as `expectedHash` (omitted only to create a file whose
  parent folder exists). Every `oldText` is located in the file as read and must
  match exactly once unless `replaceAll` is set; edits must not overlap and are
  applied together or not at all. A file keeps its line endings and BOM; a new
  file is written exactly as supplied. Writing uses a temporary file in the same
  folder and a rename, so a failure leaves the original intact.

The diff is computed by the service from the file on disk when the model proposes
the edit, and is what the approval card shows under **View details** with the path and
added/removed line counts. The approval is bound to the folder permission
revision and to the hashes of the content before and after the edit. If the file
or permission changes after the proposal, the edit is refused, including after
approval, and the model is told to read again. A missing, ambiguous or
overlapping `oldText`, a stale hash or a change that makes no difference is
reported to the model before any approval is requested, with the line numbers to
look at. Edits within the service are serialized per file.

Paths are relative to the folder. Dot-named configuration such as `.github` and
`.gitignore` is available; `.git` internals, `.env` files other than
example/sample/template/dist variants, SSH/cloud credential folders, `.npmrc`,
`.netrc` and key or certificate files are refused, including through links.
This keeps credentials out of ordinary reads; it is not a boundary, because the
terminal itself can reach them. Binary, UTF-16, non-UTF-8 and files over 8 MiB
are refused with a pointer to the terminal. Rename, move, delete and running
programs stay with `runTerminalCommand`. Exact edits appear in the files-changed
summary and execution records with their diff.

## Files changed by a reply

After the assistant finishes, **Recently edited files** appears below its reply when
terminal results contain detected changes. Each row shows a relative path,
created/modified/deleted status and a line-count or size summary. These are
filesystem observations rather than a model-generated description of intent.
Repeated edits in the reply are merged; creating then deleting a file leaves no
net row. Three compact rows are shown initially, with an expand control for longer lists.
Approval pauses and active generation do not display a completed change card.

Each terminal command compares working-directory snapshots before and after
execution, including failed commands and stopped commands that wrote files.
Reads and unchanged files are omitted. File contents are hashed (files up to 8 MiB
also get a UTF-8 line count) without keeping file text in memory. Each folder's
last walk is remembered for the four folders most recently used, so a later walk
reads only files whose size or times changed; choosing a folder as a
conversation's workspace reads it in the background, so its first command does not
wait for a full read. A rename appears as deletion plus creation.
Results are part of the existing tool output, so they survive chat reload,
service restart and backup without a separate store or database migration.
Older results without observations remain readable without inventing file lists.

Observation is limited to the working directory and skips junctions/symlinks,
`.git`, `node_modules`, `.next`, `.venv` and `__pycache__`. Each walk considers up
to 100,000 entries for up to 10 seconds and reads up to 1 GiB of changed files. At
most 100 change rows are shown per command.
These are observation budgets, not command input or execution restrictions.
Interrupted, unreadable or truncated observations are explicitly labeled as
partial. Partial walks do not treat an unobserved file as proof of absence.
Concurrent external edits may be observed during the same window; the card is
not a forensic audit of every file touched. Changes outside the working directory
are not claimed. Revoking permission prevents a new post-command observation.

### Undoing a reply's file changes

Undo puts a file the reply changed back as it was before the reply: earlier content
restored, a file the reply created deleted, a file it deleted written again. Every
undo can be redone, so none of it asks for confirmation beyond choosing the files:

- **Undo changes** at the top of the card opens a list of the reply's files, checked
  against the files as they are now. Every file that can be undone is ticked; untick
  the ones to keep. The button says how many files it will undo. With only one file
  to undo, it is undone at once.
- **Undo this file** in a row's ⋯ menu undoes that file alone, at once.
- The result is a short notice with **Redo**, which takes that undo back for exactly
  those files. An undone row reads "Undone" and "Back as it was before this answer";
  its ⋯ menu then offers **Redo this file**, and the top of the card **Redo changes**
  once nothing is left to undo. The card shows how many files are undone, and keeps
  showing it after a reload.

A rename shows as a deleted and a created file; the two are marked as one rename and
are undone and redone together, since one alone would leave both names or neither. A
file that changed again since the reply (by you, another program or a later reply) is
left alone, and its row says so; so is one whose earlier content was not kept, with
the reason. Redo likewise leaves a file that changed after the undo. Before an undo
replaces or deletes a file it keeps what the file held (up to 64 MiB), which is what
redo writes back; a larger file can be undone but not redone. Undoing an answer that
ran in several requests (approvals) covers all of them. The next reply is told which
files you undid or redid, so the model reads them again rather than building on an
old view. Undo and redo are refused while the conversation is still answering.

Each file is checked again at the moment it is changed, not only when the list is
read (`src/lib/checkpoints/commit.ts`). The file is first moved aside under a
temporary name in one step, so what is checked is exactly what is replaced; a file
that is no longer as the reply (or the undo) left it is put back untouched and
reported as changed, and its records stay as they were. New content takes the name
only while nothing else holds it (a hard link, or an exclusive copy where the drive
has none), so a file created under the same name in the meantime is never written
over. The moved-aside file is removed only once the change is recorded; a change that
cannot be recorded is taken back. RiA's own writes to one file take turns
(`src/lib/local-files/file-writes.ts`): an undo and an `editProjectFile` edit of the
same file never interleave, and the edit's own hash check refuses an edit planned
against content an undo replaced. Content restored from git is written to a new
temporary file, and the restore settles only after git has exited and the file is
closed; a failed write stops git, and only a file the restore created is removed.

What makes this possible is a checkpoint per changed file, recorded for edits made
with `editProjectFile` and for changes a command made in a conversation. The content
before the change is kept by its SHA-256 in `checkpoints/blobs/` in the cache folder (beside the database unless one was chosen),
once however many files or replies share it; the `file_checkpoints` table
(`20261119100000_file_checkpoints`) names the hashes, the folder and the run. For
commands the content comes from the walk before the command, which makes each file
recoverable as it was first seen and again whenever it changes:

- **Git.** In a git repository (the workspace or a folder inside one), a file whose
  bytes are exactly its blob in the index needs no copy, whatever its size: undo
  takes it back from git (`git cat-file`) and checks it against the recorded SHA-256.
  Git is used only if it is installed; a blob git no longer has falls back to a copy,
  if there is one.
- **Copies.** Other files up to 64 MiB are copied, gzip-compressed when a sample shows
  that saves space (media and archives are stored as they are).
- **Not copied.** Files git ignores and larger than 1 MiB (build output, caches; a
  small ignored file such as `.env` is still copied), files over 64 MiB that git does
  not hold, files the walk did not reach in time, and new files once the store is
  full. Their changes are listed as not undoable, with the reason.

Checkpoints are kept for 14 days. The store holds up to 2 GiB unless changed in
**Settings → Workspace permissions → Undo storage limit** (1, 2, 5, 10 or 20 GB),
which also shows how much it holds. When the store is full, new files are not
copied: each is noted once and not read again until room opens up, so a full store
does not keep reading, copying and dropping. Content an undo needs is always written.
Past the limit, copies kept only in case a file changes later go first, then the
content needed by the oldest changes, which become not undoable. A lower limit is
applied at once. Content that no checkpoint or remembered folder needs is removed at
start-up and shortly after new checkpoints. Revoking a folder removes its
checkpoints. Deleting a conversation removes its checkpoints with it. Checkpoints
are not part of backups. The new tables (`file_checkpoints`, `checkpoint_preferences`)
are additive; older builds ignore them. The store lives beside the database, in the
data directory.

`POST /api/conversations/:id/undo` takes `{ runIds, action, files? }`. `action` is
`status` (each file's state from the records alone, without reading any file: what
the card shows), `preview` or `redo-preview` (what would happen to each file, checked
against the files now, changing nothing), `undo` or `redo`. Each returns `files[]`
with `path`, `action`, `status`, `undone`, `redoable` and, for half of a rename,
`pairedWith`. `files` (`[{ grantId, path }]`) limits any of them to those files.
`status` has its own, higher request limit, since every card reads it as it comes
into view. `GET`/`PUT /api/checkpoint-preferences` reads `{ limitMb, usedBytes,
choicesMb }` and sets `{ limitMb }`.

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
