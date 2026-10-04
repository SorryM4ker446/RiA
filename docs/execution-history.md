# Execution history and recovery

Settings → Scheduled tasks displays the latest 50 executions separately from
schedule configuration and notices. Each execution records a stable identity,
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
The additive database migration creates only the execution table and indexes.
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
