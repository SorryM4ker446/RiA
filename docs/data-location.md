# Data and cache location

RiA keeps everything it stores on the computer it runs on. By default that is `%APPDATA%\RiA\data` for an installed copy and `.desktop-data/dev` in a development checkout, on the system drive whichever drive RiA is installed on. **Settings › Storage › Data location** moves it to another drive, and can give the cache a folder of its own.

## What lives where

| Part | Contents | Moves with |
| --- | --- | --- |
| Data | `app.db` (conversations, tasks, knowledge, usage), `media/`, `backups/` (workspace archives, pre-migration `.bak` files, workspace-upgrade snapshots), `config/settings.json` (encrypted keys), `logs/` | **Data location** |
| Cache | `checkpoints/` (undo copies), `terminal-logs/` (full terminal output), `chromium-cache/` (the window's web cache) | The data, unless a cache folder is chosen |
| Profile | `%APPDATA%\RiA` itself: Chromium's encryption key, drafts and screen state (Local Storage), the data location record `data.location.json` | Never moves; it is small |

## How the data is found

RiA always opens its data at the same fixed path. After a move, that path is a directory junction pointing to the new folder. Every version of RiA, the installer, in-app updates, pre-migration backups and the update log keep using the fixed path, so none of them needs to know the data moved. An older version installed over a newer one still finds the data.

`data.location.json` beside the fixed path records a move waiting for the next start, the last move's outcome, the old copies a move left behind, the cache folder and whether the low-space hint was shown. It never decides where the data is; the junction does. A copied or adopted data folder carries `.ria-data.json`, so a junction can tell RiA data from any other folder.

## Moving the data

1. **Change location…** opens the system folder picker. RiA checks the folder before anything is written:
   - it must be a full path on a local drive, not a network share;
   - it must not be inside the current data folder, or contain it;
   - it must be writable and able to hold a junction;
   - there must be room for the data plus 10% and 256 MB.

   An empty folder receives a copy. A folder that already holds RiA data (one RiA moved there, or a copy whose database RiA's migrations ran on) is used as it is; the current data is not merged into it and stays where it is as an old copy.
2. The dialog shows where from and to, how much is copied and how much is free, and warns when conversations or tasks are answering, since the restart cuts them short. **Move and restart** records the move and restarts RiA. A move cannot be requested while an update is downloading, downloaded or installing, and an update does not start while a move is waiting.
3. At the next start, before anything opens the data (the desktop log included), a small window shows the progress:
   - the database is copied with SQLite's online backup and checked with `PRAGMA integrity_check`;
   - every other file is copied and compared by SHA-256, then file counts and sizes are compared;
   - the web cache is not copied; it is rebuilt.

   **Cancel**, or closing the window, stops the copy, removes it, and starts RiA with the data where it was.
4. Only after everything matches does RiA switch: the old folder is renamed `data.moved-<time>` beside the fixed path and the junction takes its place. Then the workspace upgrade, then the database migrations, then the service, so an update's migrations always run on the data where it now lives.
5. RiA opens normally and says, once, that the data moved. The old folder stays under **Old data copies** until it is deleted there. Each copy says why it was kept: moved away from, not found when an empty workspace was started, or left by a move that did not finish. **Use this data…** switches back to a copy as it is (the data in use is kept as a copy in turn). Deleting is permanent, asks first and shows the size. Only folders on that list can be deleted, and only ones set aside beside the fixed path or carrying RiA's marker; never the data in use or anything containing it.

**Move back to the default location** in the data row's menu copies the data back to the fixed path the same way.

Each step is recorded before it is taken. After a crash or power loss, the next start either finishes the switch or puts the old folder back, and removes an unfinished copy. Only a folder carrying RiA's own incomplete marker is ever removed.

## When the data cannot be found

If the folder the junction points to is missing (a drive unplugged or given another letter, the folder renamed), or the fixed path is gone while copies set aside beside it remain, RiA does not open an empty workspace in its place. It asks, offering:

- **Try again**, after reconnecting the drive;
- **Choose the data folder…**, to point RiA at the data's new path (only a folder holding RiA data is accepted);
- **Use an earlier copy**, when an old copy still exists, saying when it is from;
- **Start an empty workspace…**, confirmed separately; nothing is deleted, and the missing location stays under **Old data copies**, marked as data that could not be found, so **Use this data…** can switch back to it once it turns up;
- **Quit**, changing nothing.

The same question is asked when a move could neither finish nor put the old folder back. A damaged `data.location.json` is renamed `data.location.json.damaged-<time>` for diagnosis and the start continues if the data opens; a record written by a newer version stops the start with a message to install that version.

## The cache

The cache follows the data by default, at the same paths as before. **Change cache location…** moves undo copies and terminal output to a folder of their own at the next start, each file checked, and then removes the old ones; the web cache is rebuilt there. **Follow the data again** brings them back.

A chosen cache folder that cannot be found does not stop the start: losing the cache loses no workspace content. RiA keeps the cache in the data folder for that run and says so in **Settings › Storage**; once the drive is back, a restart returns to it. Moving the cache again from there carries what was written in the meantime. The data cannot be moved into the cache folder, or the cache into the data folder.

## Low disk space

When the drive holding the data has less than 5 GB free, RiA suggests once, after it opens, that the data can be moved.

## Installing, uninstalling and updating

- The installer has no data location option. A per-machine installation is elevated, possibly by another administrator account, while data belongs to each Windows account; each account chooses in RiA.
- Uninstalling keeps the data, at the default path or wherever it was moved, and the junction. Reinstalling under the same account finds it again. To remove everything, delete the data folder (and any old copies) and `%APPDATA%\RiA`.
- In-app updates keep using the fixed path. The download stays in `%TEMP%\RiA-updates`, and Windows Installer keeps its own copies in `%WINDIR%\Installer`, both on the system drive; moving the data off that drive leaves room for them.
- Before this release, Chromium kept its web cache in `%APPDATA%\RiA\Cache`. It now lives in the cache folder, and the old folder is removed at the first start.

## Downgrading and rollback

An older version opens the data through the junction like any other folder. Before installing a version from before this feature over a moved workspace, move the data back to the default location if that version has to see later moves or old copies; the junction itself keeps working. The pre-migration `.bak` file in `backups/` restores the database as before any migration.

## Development and tests

`DESKTOP_DATA_DIR` sets the fixed path; a move works there as well. `npm run test:desktop:data-move` records a move before launching Electron and runs the whole smoke test through the junction; `tests/desktop/data-location.test.ts` covers moves, recovery, the cache and copy deletion with real junctions.
