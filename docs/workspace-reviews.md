# Factual workspace reviews

RiA records certain changes in the workspace as events, so a review can say what actually happened rather than guess from current totals or a model's reconstruction.

There are two ways to read them:

- **Settings → Automation & notifications → Local fact review** shows a day or a week for a chosen IANA time zone, with counts and source links. It makes no model call.
- The model reads the same facts with the `readWorkspaceActivity` tool. The daily brief and weekly summary are [task templates](tasks.md#templates): a task made from one asks the model to call it and summarise, answers in the task's conversation, and can be edited like any other. Nothing runs until you save such a task.

A daily review covers the previous complete local calendar day; a weekly review covers the previous complete Monday–Sunday week. The time zone decides the boundaries. Start is inclusive and end is exclusive, and daylight saving can change how many hours a day has.

## Recorded changes and source evidence

- Documents: first import records an import; changed content or collection records an update. An identical import and index repair record nothing.
- Memories: a new manually accepted memory, or an unconfirmed memory the user then accepts, records a confirmation. Assistant inference and edits to an already confirmed memory record nothing.
- To-dos: completing and reopening a to-do were recorded until to-dos were folded into tasks. Those events remain in their periods, labelled as they were, and their sources are shown as no longer available. No new ones are recorded.

Each event and its change share a transaction; a failed event write rolls back the change. An event keeps a short label and timestamp after its source is deleted, not a copy of the source. Source links open the current document or memory and say clearly when it has been deleted. A later rename, edit or deletion does not rewrite the recorded event or its count.

Recording started when this feature was installed; existing data was never backfilled as activity. A review says when complete coverage begins, and a partially recorded period means "recorded changes", not a claim that earlier activity was zero. Counts include every retained event in the period; only the first 100 sources are listed, with the number left out.

## What the model is given

`readWorkspaceActivity` returns the period, its time zone and boundaries, the counts, whether coverage is complete, and the listed sources with their labels. It writes nothing. It is offered to the model with `createTask`: a conversation with no template restrictions has it, and a template has it when it allows `createTask`. A person cannot pick it from the menu.

What the model writes from it is interpretation, kept in the task's conversation. The counts in the local review remain the record.

## Retention, portability and upgrade

Events keep at most 10,000 rows and 365 days. Writes and reads clean up and advance the complete-coverage boundary, so older periods can be partial.

Earlier versions saved a frozen review, and a conversation for it, each time a daily or weekly schedule ran. Those saved reviews and their conversations are kept and still travel with backups, but no new ones are made.

Backups include events, coverage and saved reviews. Restore remaps source IDs while keeping event links, makes no synthetic changes, and starts a new recording boundary for older archives without these fields. See [Workspace backups](workspace-backups.md) for older-reader limitations.
