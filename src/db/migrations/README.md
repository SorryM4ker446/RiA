# Database migrations

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

If you add a migration, do not edit an existing one. An installation that has
already applied a file will not run it again, so a corrected file would never
reach it.
