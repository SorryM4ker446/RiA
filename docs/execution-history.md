# Execution history and recovery

New chat executions have no aggregate time, tool-step count or failure-count
ceiling. Individual terminal commands have no automatic time limit either.
Manual cancellation, directory permissions, approval modes and configured model
call controls still apply. Historical executions retain their original budgets
and stop reasons. The execution details display unlimited counts and no total
deadline explicitly.

Long tool turns can produce reasoning longer than the user text-input limit
and more than 100 assistant message parts. Follow-up requests and approval
continuations accept that protocol state without truncating saved reasoning.
User text, non-assistant part counts, attachment limits, tool input validation
and approval binding checks still apply.

Historical tool evidence uses at most 4,000 characters per call. Terminal
outcomes and exit codes precede command excerpts; diagnostic lines, stderr,
reported file changes and captured stdout have separate budgets. Long streams
and inputs retain explicitly marked head/tail excerpts. The capture truncation
flag remains separate from historical excerpting, and partial file observations
retain their completeness and omitted-file counts. Excerpts cannot recover
output that was already lost at the terminal capture limit.

The smaller older-history excerpts and newly generated conversation summaries
reuse this formatter, prioritizing recent calls over long command prefixes.
Saved messages, existing summaries and active approval payloads are preserved;
historical records never authorize another execution.

Model-aware budgets and task handoffs now control long tool loops. See
[context capacity and task compaction](context-management.md) for configuration,
failure behavior, compatibility and remaining long-task limits.

## Chat tool details

Chat execution records use one tool-call list for live messages, saved full
details and step summaries, with the latest call first. Summaries are marked as
waiting while the request is active, or unavailable after it ends. They do not
pretend to contain a full command or terminal output.

New steps retain the SDK tool call ID. Full details enrich the matching call
without replacing its row, collapsing it or resetting the reader's position.
The existing run refresh detects newly linked messages and completion; details
are fetched at those transitions when missing or incomplete; complete live
messages are reused. Requests are aborted when the panel closes or the
conversation changes. Normal completion is recorded after response
persistence so the last refresh can retrieve its saved details. A save failure
ends the run as failed rather than leaving it running.

Historical steps remain supported. Full messages are linked by explicit run
identity, or by an unambiguous legacy request window. Call names and array
positions are never used to guess a match. Missing full messages retain their
saved summaries; an explicitly linked full historical message can be displayed
without inventing individual step associations.

## Scheduled executions

**设置 → 自动化与通知 → 最近执行** displays the latest 50 executions separately from
schedule configuration, factual reviews and notices. Retention and retry rules
are available under **记录保留与重试规则**. Each execution records a stable identity,
trigger, start and finish times, status, fixed failure category and model request
identity. Generated conversations and backups have an entry point in the list.
Marking a notice read or deleting a schedule does not erase execution history.
Deleted conversations clear the history link; backup cleanup may remove an older
archive, so its history entry opens the backup list.

Automatic scheduling only runs inside the desktop service. Browser development
servers show that automatic execution is inactive. Restore holds the workspace
gate: polling defers without claiming an execution. Once restoration completes,
schedules remain paused until explicitly enabled. Deferral is not an executed
failure. Older last-result fields are not fabricated into historical executions.

Claims and execution rows are committed together. Only one schedule may execute
at a time, including while its configuration is deleted. Completion atomically
closes its execution and advances the schedule strictly beyond completion time.
On desktop service startup unfinished executions become interrupted, without
automatically replaying any writes.

## Explicit recovery

For an enabled schedule, **Run again once** can retry its latest failed execution
without a recorded artifact. It creates a new execution and request identity;
one failed execution authorizes at most one retry even for concurrent requests.
Each subsequent failure can be considered independently. The current schedule,
model membership and credentials are checked again. Each model retry can incur
a new charge. A normal due occurrence during that run is consumed rather than
immediately executed again afterwards.

Succeeded, interrupted and artifact-producing executions cannot be retried with
this control. After interruption, check existing conversations, tasks and backups
before deciding what to do: termination may occur after a side effect but before
completion is recorded. Exactly-once filesystem durability across termination
is not guaranteed. Tool records provide failure categories and recovery guidance;
continuing requires a new chat request and applicable approvals and directory
grants. No prior approval is replayed.

## Retention, backup and diagnostics

Scheduled execution history retains at most 1,000 completed records for up to
90 days. Cleanup runs at startup and execution completion. Running records are
excluded. These limits are fixed in this version. Existing agent history remains
attached to its conversation and is deleted when that conversation is deleted;
this change does not add an agent retention policy.

Scheduled history is local operational evidence, excluded from portable backups.
Existing history stays on the restoring machine, links to replaced conversations
are cleared and schedules are paused. Old version-1 archives remain supported.
The execution-history migration creates only the execution table and indexes.
Close the service and keep a full data-directory copy before rolling back to an
older application version.

**Export sanitized diagnostics** downloads the latest 100 scheduled executions
and 100 agent runs, with at most 32 step status/error entries per agent run.
Identities are hashed for correlation and string categories are allowlisted.
Goals, prompts, model names, messages, tool inputs/outputs, raw errors, paths,
provider keys, access credentials and desktop log contents are excluded.
Timestamps and statuses are still activity information.

## Local API

All endpoints require normal local credential, Host and Origin checks and return
private/no-store responses. Export and retry use existing rate limits.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/schedules/runs` | Latest 50 executions, retention constants and automatic scheduling availability |
| `POST /api/schedules/:id/retry` | Strict JSON `{ "runId": "latest-failed-execution-id" }`; executes once and returns HTTP 201 with the new identity and outcome; operation failure remains an explicit failed outcome |
| `GET /api/diagnostics` | Download bounded sanitized JSON diagnostics |

Stale, repeated, paused or overlapping retries return 409. A missing schedule
returns 404. The retry request waits for completion; a lost HTTP response does
not authorize replay of the same failed record. Refresh history to find its
accepted execution before making a new decision.

## Factual review outcomes

Daily and weekly schedules now generate [factual workspace reviews](workspace-reviews.md).
A missing model or failed optional commentary is a successful local result with
an explicit model warning, not a failed execution eligible for retry. New and
upgraded schedules disable model commentary until explicitly enabled. True
persistence failures still fail the execution and remain subject to the recovery
rules above. Unfinished commentary becomes interrupted at service startup; the
same retained period is reused without another paid attempt. Workspace events
and review snapshots are portable business data, unlike scheduled execution
history, and are included in backups.
