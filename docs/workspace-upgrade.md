# Local workspace upgrade and recovery

The application is moving from account-scoped data to a single local workspace.
This page describes the upgrade machinery that runs **before** the application
itself changes, so an installed copy can be converted without silently losing
content.

## What "an account" means here

Earlier versions created a `User` row per installation and scoped every
conversation, message, memory, task, media asset, document and usage record to
it. The desktop application hid this behind `AUTH_DISABLED=1` and a shared demo
account. The workspace upgrade removes that layer: one local workspace owns the
data, and access is protected by the local application credential instead.

## What runs before the migration

```
npm run workspace:status     # read-only plan: what would be converted, and how
npm run workspace:prepare    # snapshot + record the adopted account
npm run workspace:restore    # put the newest verified snapshot back
npm run workspace:inventory  # read-only report of every local data file
```

Browser development runs the first two automatically as part of
`npm run dev`. The desktop application prepares the upgrade itself before its
migrations.

The preparation step:

1. Inspects the database read-only: every account and how much content it owns.
2. Decides which account to adopt.
3. Copies the whole database into `.desktop-data/*/backups/<timestamp>-pre-upgrade/`
   together with a manifest holding counts, the SQLite integrity result, a
   SHA-256 checksum and an index of the media files the database refers to.
4. Re-verifies that copy, and only then records the adopted account.

The upgrade never deletes anything on its own. An account that is not adopted
stays in the snapshot.

## How the account is chosen

| Situation | Behaviour |
| --- | --- |
| No database, or a database without accounts | Initialize the workspace directly; nothing to convert. |
| Exactly one account, with or without content | Adopt it automatically. |
| Several accounts, but only one holds content | Adopt the one with content. |
| Several accounts with content | **Stop and ask.** No snapshot is taken and no data is touched until a choice exists. |

A placeholder account (the demo user with no conversations, tasks, memories or
media) never counts as content, so an ordinary installation upgrades without
prompting.

To choose explicitly, write the account id to
`<backups>/workspace-adoption.json`:

```json
{ "version": 1, "ownerId": "cmt4aw3vg0000v1j0gkv9bhei" }
```

or set `LOCAL_WORKSPACE_OWNER` for one run. Ids are limited to letters, digits,
underscores and dashes; anything else is refused rather than ignored.

## Recovering from a failed upgrade

Every snapshot is self-describing and verified before it is used:

- `snapshot.json` records the source database, its size and SHA-256, the adopted
  account, per-table counts, and how many referenced media files were missing.
- `media-index.json` lists each referenced media file with its size and
  checksum.

`npm run workspace:restore` refuses to restore a snapshot that fails
verification, and keeps the file it replaced as
`app.db.<timestamp>-before-restore.bak` so a restore can itself be reversed.

## Media files

Snapshots record media references but do not copy media bytes, because the
library can be large. `npm run workspace:inventory` reports the media files that
exist and flags the ones a database refers to but that are missing, so a
missing file is visible before an upgrade rather than after.

## Why foreign-key handling matters

SQLite runs cascading deletes whenever a referenced row disappears. Removing the
account tables naively deletes every conversation, message, memory and media row
with them. The migration therefore:

1. rebuilds every table that references `users` **before** `users` is dropped,
2. removes rows of accounts that were not adopted while their conversations
   still exist,
3. runs with foreign-key enforcement switched off around the transaction,
   because SQLite ignores `PRAGMA foreign_keys` inside an open transaction,
4. verifies the result with `PRAGMA foreign_key_check` and
   `PRAGMA integrity_check` afterwards.

Both the desktop migrator and the local development migration path honour this
contract.

## Migration ledgers

A database carries two records: Prisma's `_prisma_migrations` and the desktop
runtime's `desktop_migrations`. Browser development and the desktop application
now use the same migrator, which skips anything either ledger already records,
so the two paths cannot disagree about what a database has received.
