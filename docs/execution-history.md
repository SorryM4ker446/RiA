# Execution history and recovery

New chat executions have no aggregate time, tool-step count or failure-count
ceiling. Individual terminal commands have no automatic time limit either.
Manual cancellation, directory permissions, approval rules and configured model
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

## Task runs

Every run of a [task](tasks.md) is recorded: when it started and finished, whether it was scheduled or started by hand, its status (`running`, `succeeded`, `failed`, `interrupted` or `waiting_approval`), a fixed failure category, and the conversation or backup it produced. **Tasks → Run history** shows the latest 50. A run keeps its task's current name, and keeps its record after the task is deleted. A deleted conversation clears the run's link to it; backup cleanup may remove an older archive, so its entry opens the backup list.

Tasks run automatically only inside the desktop service. A browser development server says so on the task page. While a restore holds the workspace, polling defers without claiming a run. A restore switches every task off.

A claim and its run record are committed together, and the claim changes the very field it matched on, so one task cannot be running twice. Different tasks can run at the same time. Completion closes the run and moves the task's next run strictly past the completion time. At desktop service startup, runs still marked running become interrupted and are not replayed.

## Recovery

There is no automatic retry. To try again, use **Run now** on the task, which starts a new run with its own identity; each model run can be charged again. After an interruption or failure, check the task's conversation and any backups first: a run can stop after a side effect but before its completion was recorded, and exactly-once filesystem durability across termination is not guaranteed. A tool call that was waiting for approval stays in the conversation for you to answer; no earlier approval is replayed.

## Retention, backup and diagnostics

Task run history retains at most 1,000 completed records for up to
90 days. Cleanup runs at startup and execution completion. Running records are
excluded. These limits are fixed in this version. Existing agent history remains
attached to its conversation and is deleted when that conversation is deleted;
this change does not add an agent retention policy.

Run history is local operational evidence, excluded from portable backups.
Existing history stays on the restoring machine, links to replaced conversations
are cleared and tasks are switched off. Old version-1 archives remain supported.
The execution-history migration creates only the execution table and indexes.
Close the service and keep a full data-directory copy before rolling back to an
older application version.

`GET /api/diagnostics` downloads the latest 100 task runs
and 100 agent runs, with at most 32 step status/error entries per agent run.
Identities are hashed for correlation and string categories are allowlisted.
Goals, prompts, model names, messages, tool inputs/outputs, raw errors, paths,
provider keys, access credentials and desktop log contents are excluded.
Timestamps and statuses are still activity information.

## Local API

All endpoints require the normal local credential, Host and Origin checks and return private/no-store responses.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/tasks/runs` | Latest 50 runs, optionally for one task with `?taskId=`, and the retention constants |
| `POST /api/tasks/:id/run` | Starts a run now; 202 once started, 409 while one is in progress |
| `POST /api/tasks/:id/stop` | Stops the run in progress; 409 when there is none |
| `GET /api/diagnostics` | Download bounded sanitized JSON diagnostics |

Activity reviews are now read by the model through `readWorkspaceActivity` inside an ordinary prompt task, so their outcome is the run's own. See [factual workspace reviews](workspace-reviews.md).
