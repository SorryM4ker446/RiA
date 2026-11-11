# Database migrations

`20261116100000_remove_knowledge_topics` removes knowledge topics and their results. Each finished
result becomes a conversation (its brief as the user's message, the result as the answer); results
without text are dropped. Topic conversations stay as ordinary conversations. `chats` is rebuilt
without `topicId` and `documentScope`, keeping its indexes and search triggers, since only a
template narrows a conversation's search now; the topic tables are dropped. Older builds cannot
read the changed tables; rolling back means restoring the backup taken before the upgrade.

`20261115100000_task_settings` adds a task's long-term memory switch, which outcomes become
system notifications and how hard the model reasons, and lets a task have no next time (run only
by hand). The task table is rebuilt to relax that column; rows and the runs pointing at them are
kept. A task whose conversation already had memory on keeps it on. Older builds cannot read a task
without a next time; rolling back means restoring the backup taken before the upgrade.

`20261114100000_approval_rules` moves "may this run without asking" from folders onto
conversations and tasks (`ask`, `acceptEdits`, `full`) and adds a one-row table for the rule new
conversations start with. Conversations and tasks in a folder that was set to full access get
`full`; everything else asks. The folder's terminal switch and mode columns are dropped, so every
granted folder can run commands, which still ask under `ask`. Older builds cannot read the changed
grants table; rolling back means restoring the backup taken before the upgrade.

`20261113100000_task_model_folder` gives a task its own model and working folder, which every
turn in its conversation uses. A folder chosen in a task's conversation moves onto its task, and
an assistant template applied to a task's conversation is taken off; other conversations are
untouched. The columns are additive and older builds ignore them, but an older build reading a
task's conversation afterwards finds it without the folder and template it had.

`20261112100000_task_templates` lets a task remember the template it was made from, so a name
or prompt it has not rewritten is worded from the template in the interface language each time,
and adds a one-row table holding the interface language the user chose. Tasks still worded
exactly as the brief or the summary are linked to it. Older builds read such a task with an empty
name and no prompt; rolling back means restoring the backup taken before the upgrade.

`20261111100000_task_missed_runs` adds a per-task choice of whether a missed time still runs once
(on by default, which is what every task already did) and, on each run, when it was due and how
many later times passed without a run of their own. It is additive, and older builds ignore it.

`20261110100000_unified_tasks` folds to-dos and the fixed schedule kinds into one kind of
task. Schedules gain a title, a prompt, a cron expression and the conversation every run
continues; their daily or weekly time is rewritten as cron, and the old time columns and
the model-commentary switch are dropped. The daily brief and weekly summary become prompt
tasks that are switched off, since a run now makes model calls the old schedule never did. Unfinished to-dos become prompt tasks that are switched off; finished ones are not
carried over, and the `tasks` table is dropped. Notices gain a column for when the desktop
was handed them; existing notices count as already shown. Desktop startup takes the normal
safety backup first, which still holds every to-do. Older builds cannot read the changed
tables; rolling back means restoring that backup.

`20261105160000_memory_resumed` adds an optional column on conversations for when long-term
memory was last turned back on, so what was said while it was off is not read for notes.
A missing value means memory was never turned back on. It is additive, and older builds
ignore it.

`20261105150000_memory_topics` adds a column to MEMORY.md's row holding how its notes are
sorted into topics, worked out from them. It is additive, and older builds ignore it.

`20261105140000_knowledge_tool_only` rewords a sentence in the default knowledge template
that spoke of evidence sent with the request, which no longer happens. A template a person
changed is left as it is.

`20261105130000_knowledge_entry_tool` renames the knowledge base's save tool in the default
templates and adjusts the sentences that named it. Older builds reading such a template
find a tool id they do not know, which they leave out.

`20261105120000_memory_document` adds a table for MEMORY.md and an optional column on
conversations. It is additive, and older builds ignore both. It also deletes candidates
written from tool results that nobody accepted, which held raw records of no use and
are no longer made; a backup keeps them if one is restored. Accepted entries stay.

`20261105090000_message_request_context` adds an optional column to messages holding
the reference data a user message was sent with, so later requests repeat it exactly
and a provider's prompt cache keeps matching. A missing value means that message is
sent without it once. It is additive, and older builds ignore it.

`20261104120000_chat_summary_state` adds an optional column to conversations
holding what goes with the summary: the tool calls it stands in for, and the files
and skills to put back after a fold. Existing summaries stay valid with nothing
recorded; a missing or unreadable value means folding again. It is additive, and
older builds ignore it.

`20261025100000_drop_task_memory_candidates` removes memory suggestions that
creating a task used to leave behind: rows whose key starts with
`tool:createTask:`, inferred by the assistant (`source = 'assistant'`) and never
accepted (`confirmed = 0`). Accepted entries and other tools' suggestions are
kept. Desktop startup takes the normal safety backup first and logs how many
rows the migration changed; running it again removes nothing. Older builds no
longer list the removed suggestions; restoring them requires the pre-upgrade
backup.

`20261023120000_default_assistant_templates` writes the four default assistant
templates into `assistant_templates` under their existing `builtin_*` ids, so
they can be edited and deleted like the user's own; until now they lived only in
code. Each row is inserted once and never overwritten. Conversations keep the
template copy they already hold, and the new revisions offer an update to it.
Older builds still list their own copies from code and would show each default
twice; deleting one there does not remove its row.

`20261021120000_model_context_calibration` adds a per-model cache of recent
ratios between provider-reported and locally estimated input tokens, used to
scale context planning for later requests. It is derived data: it is not part of
workspace backups, and a missing or unreadable row falls back to the uncalibrated
estimate. Older builds ignore the additional table.

`20261020200000_agent_step_tool_call_id` adds an optional tool call identity to
execution steps, allowing saved summaries to be enriched with the matching full
tool message. Existing steps remain valid with a null identity; no historical
matches are guessed. Startup applies this additive migration with the normal
backup. Older builds can ignore the additional nullable column.

`20261020140000_unbounded_agent_runs` makes run step, failure and total-duration
limits nullable. New records default to no aggregate limit; existing run budgets,
steps, indexes and chat relationships are preserved. Individual terminal commands
also have no automatic timeout. Desktop startup creates
the normal safety backup and applies this migration once. Older builds cannot
interpret null budgets; rollback requires the pre-upgrade database backup.

`20261019180000_terminal_approval_mode` adds a per-folder terminal approval mode.
Existing terminal grants retain per-command approval. Selecting full access is
an explicit permission update; disabling, re-granting or restoring resets the mode
to approval. Older builds must not be used to manage full-access grants, because
they do not understand this mode.

`20261018180000_terminal_permissions` adds a separate, default-off terminal
permission to directory grants. Existing file permissions do not gain command
execution. Terminal permissions are machine-local and revoked on portable restore.

`20261018120000_plugin_packages` adds machine-local plugin manifests and optional
extension ownership. Existing connections retain their IDs and activation state.
The plugin migration test verifies the safety backup, repeated startup and owned
connection cascade, independently of the prior extension migration.

Each subdirectory is one migration, named `YYYYMMDDHHMMSS_description`, and the
name is the whole of its metadata: it is the primary key in the `desktop_migrations`
ledger and its sort order is the order the migrations run in.

`electron/migrations.ts` applies them at every service start. For each one it has
not already recorded, it reads the file, runs it inside `BEGIN IMMEDIATE`, and
writes the ledger row in the same transaction, so a failure cannot leave a
half-applied migration marked as done. A rebuild of a table runs with
`PRAGMA foreign_keys = OFF` around the transaction, because SQLite ignores that
pragma inside one, and re-checks `PRAGMA foreign_key_check` afterwards.

## The chain is also the test corpus

**This is not a historical record that can be squashed.** Three separate things
read it:

1. `electron/migrations.ts` applies it to the real database.
2. `tests/helpers/database.ts` applies all of it to build an isolated test
   database, and `tests/helpers/legacy-workspace.ts` uses the same helper to
   build fixtures.
3. `tests/desktop/*-migration.test.ts` treat the chain as a **corpus of database
   versions**. Each one names a range, applies the migrations in it, and then
   checks that a data conversion came out right — prefix-stripping message
   content, rebuilding the FTS index, dropping a malformed term row.

That third consumer is the one that is easy to miss. Because the application has
never been released, the chain is the only record of what an earlier version's
database actually looked like. Deleting or squashing it does not merely shorten
the SQL; it deletes the fixtures, and with them the only coverage of the
migration engine itself.

### Migrations named in code

Renaming or merging any of these breaks a test, because the tests spell the
names out as the boundaries of the version they want to reconstruct:

| Name | Referenced by |
| --- | --- |
| `20260830200000_document_knowledge` | `tests/desktop/document-migration.test.ts` (lower bound) |
| `20260831100000_conversation_management` | `tests/desktop/conversation-migration.test.ts` (lower bound) |
| `20260831120000_media_library` | `tests/desktop/media-library-migration.test.ts` (lower bound) |
| `20260831150000_account_preferences_and_model_usage` | all three (upper bound: the last migration before account scoping was removed) |
| `20260901100000_single_user_workspace` | `SINGLE_USER_WORKSPACE_MIGRATION` in `tests/helpers/legacy-workspace.ts`; also the split point that separates the account-scoped migrations from the rest |

`tests/helpers/legacy-workspace.ts` also derives `ACCOUNT_SCOPED_MIGRATIONS` by
comparing every name against `20260901100000_single_user_workspace`, so the
multi-user fixtures are "everything before that one".

Migrations after `20260901100000` are not named anywhere, so they are the only
ones a change could touch without editing a test.

## Renaming or merging is not just a test problem

An installed database records the name of every migration it has applied, in
`desktop_migrations`. The runner applies anything it does not find there. So
renaming a migration — or merging several into one — makes an existing database
apply the renamed file **on top of itself**, and the failure is a duplicate
column or a duplicate table rather than anything that names the real cause.

This happens on a development database that has already been migrated, which
`npm run desktop:build` uses (`.desktop-data/dev/app.db`), and it would happen on
any installation, released or not. Merging thirteen migrations was tried and
reverted for exactly this reason: the schema it produced was byte-for-byte
identical, and `npm run test:server` passed, and the desktop build still failed
with `duplicate column name: embeddingModelId`.

To restructure the chain, the ledger has to move with it — the old names would
need their own migration that records them as applied. That is more machinery
than the shorter chain is worth.

## Before you change anything here

Run the full suite. `npm run test:desktop` is what catches a migration change;
`test:server` builds its databases from this folder too, so it will also fail,
but with a much less obvious message.

### `npm run db:check`

The Prisma client is generated from `schema.prisma`, not from the database, so
a column added to the schema and not to a migration still type-checks — the
client believes it exists and the error only appears where a query reads it.
Nothing else compares the two.

`scripts/check-schema-drift.mjs` builds a database by applying every migration
and asks Prisma what it would change to bring that database back in line with
the schema. Anything it reports is drift. It runs in CI, and in `npm run test`.

Full-text search is the one deliberate exception: the FTS5 virtual tables and
the shadow tables SQLite builds for them are not described by any Prisma model.
The script finds them by reading the migrations for `CREATE VIRTUAL TABLE`, so a
new one needs no change to the script.

If it reports a change, the fix is to write the migration — not to edit the
script, and not to relax the schema.

If you add a migration, do not edit an existing one. An installation that has
already applied a file will not run it again, so a corrected file would never
reach it.
