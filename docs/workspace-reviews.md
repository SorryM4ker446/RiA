# Factual workspace reviews

Settings → Scheduled tasks includes a local review preview and optional daily
and weekly schedules. Counts come from persisted events, not current totals,
`updatedAt`, or a model's reconstruction. A daily review covers the previous
complete local calendar day; a weekly review covers the previous complete
Monday–Sunday week. The schedule's IANA time zone determines the boundaries.
Start is inclusive and end is exclusive; daylight saving can change elapsed hours.
Missed polling generates the latest complete period once, without a backlog.

## Recorded changes and source evidence

- Tasks: transitions into `done` record completion; transitions from `done` record
  reopening. A task may contribute multiple distinct transitions. Repeating an
  unchanged request contributes nothing. Recurrence and its event commit together.
- Documents: first import records import; changed content or collection records
  update. Identical import and index repair contribute nothing.
- Memories: a new manually accepted memory or an unconfirmed memory explicitly
  accepted by the user records confirmation. Assistant inference and edits to an
  already confirmed memory contribute nothing.

Each event and its business change share a transaction. A failed event write rolls
back the change. Events preserve a short label and timestamp after source deletion,
not a full historical source body. Source links open the current surviving task,
document or memory and clearly identify deleted sources. A later rename, reopen,
edit or deletion does not rewrite the recorded event or its historical count.

Migration starts recording now; existing data is never backfilled as fabricated
activity. The report states when complete coverage begins. A partially recorded
period means “recorded changes,” not a claim that earlier activity was zero.
Counts include all retained events in the period; only the first 100 source links
are listed, with an explicit omitted count.

## Local facts and optional interpretation

Preview is live, local and free of model calls. Scheduled execution atomically
saves deterministic facts and a conversation before requesting optional commentary.
New schedules and existing schedules upgraded by migration default to no model
commentary. Enabling the checkbox authorizes one bounded model attempt for a new
period snapshot; empty periods skip it. Missing model configuration and provider
failure retain the local report and show a warning in execution history.

Commentary is separately labelled as interpretation. It receives only period,
coverage and event counts, without source names or bodies, and does not replace
those counts. Each call has no retries, a 60-second deadline and a 512-token output
limit. Actual calls use the existing model usage tracking. Provider charges may
still apply to a failed or interrupted attempt.

Period, canonical time zone and start boundary identify a saved review. Two
schedules for the same period reuse it, and failure or interruption does not
trigger another model call. Changing the model checkbox affects future new
snapshots, not an existing snapshot. If its conversation is deleted, the retained
snapshot can recreate it without calling a model. Preview can differ from a frozen
report after late import or restore; a report remains the evidence recorded when
it was first generated. Startup marks unfinished commentary as interrupted.

## Retention, portability and upgrade

Events retain at most 10,000 rows and 365 days. Event writes and preview/report
reads perform cleanup and advance the complete-coverage boundary; older periods
can therefore be partial. Review metadata retains at most 1,000 rows and 90 days;
report creation cleans up completed metadata and preserves pending work. Saved
conversations remain under the normal conversation deletion rules. Period reuse
applies while its review metadata is retained; expired source links return 404.

Backups include events, coverage and review snapshots. Restore remaps current
source IDs but preserves event links, performs no synthetic business mutations,
and marks pending commentary interrupted. Older archives without these fields
start a new recording boundary at restore. Scheduled execution history stays
local. See [Workspace backups](workspace-backups.md) for older-reader limitations.

The additive migration creates event, coverage and review tables and adds
`useModel: false` to schedules. Restart the desktop service to apply it through
normal backed-up migrations; browser deployments use the existing migration
command. Keep a full data-directory copy and a compatible archive before rollback.
No provider key, new dependency, background worker or CI service is required.
