# Windows release acceptance

Run installation and upgrade checks in a disposable Windows VM, under the same Windows user for DPAPI-encrypted settings. Do not install a test build over a personal workspace. Code signing is outside the current release process. In-app updates are covered by their own scenario below.

Record the release version, each installer’s SHA-256 from `verification.json`, Windows build, installation type, tester and date. A checksum identifies an artifact; it does not prove publisher authenticity. Generated manifests mark manual checks unverified until a tester records evidence.

Initialize the structured acceptance record after building both release installers:

```powershell
npm run desktop:acceptance -- --init
```

This reads `out/make/wix/x64/verification.json`, verifies each recorded installer’s size and SHA-256, and creates `acceptance.json` beside it. Every scenario starts as `not-run`. CI initializes this unverified template to validate the command. For publication, download the two installers and `verification.json` from the GitHub draft and pass the downloaded manifest path with `--manifest`. Keep each release's record and evidence together. Initialization preserves any existing record, and a build with different bytes requires fresh acceptance.

Fill `environment.windowsBuild`, `vm` (disposable VM identity), `installationType`, `tester`, and `previousVersion` (the lower release used for upgrade). For each scenario in the generated record, set `result` to `pass`, `fail` or `not-run`, `testedAt` to a UTC ISO timestamp (for example `2026-10-07T08:30:00Z`), and `evidence` to one or more nonempty file paths. Relative paths are resolved from the acceptance record's directory; absolute paths are also supported. Use screenshots and sanitized logs, never provider keys, passwords or connection strings. Do not use the installer, checksum manifest or acceptance record itself as scenario evidence.

After performing and reviewing every scenario, verify the completed record:

```powershell
npm run desktop:acceptance -- --check --output out/make/wix/x64/acceptance-verified.json
```

The check rejects changed installer bytes/version, missing or duplicate scenarios, failed/unperformed results, missing environment information, invalid/future timestamps, and missing/empty evidence. It creates a receipt with SHA-256 hashes of the record and evidence files, without copying their contents. Existing output files are preserved; choose a new receipt filename for a later check. Omitting `--output` prints the JSON receipt without writing a file. `--manifest <path>` and `--record <path>` allow checking an archived release outside this checkout.

`verification.json` remains the artifact identity record with initial unverified placeholders; `acceptance.json` is the tester's manual result record. A passing check validates those attestations and their file references, not screenshot contents, publisher identity, or whether a physical test actually occurred. Keep the receipt with the exact installers and reviewed evidence, and use the CI logs separately for automated build/package/smoke results. This command neither installs software nor publishes artifacts.

| Scenario | Procedure | Evidence required |
| --- | --- | --- |
| Clean installation | Install the built MSI in a clean VM without Node/npm or repository files, approving the administrator prompt. Cover the default `Program Files` destination and, with the Chinese wizard's Browse control, a D: folder including spaces and Chinese characters. Launch from Start menu as a standard user. | Destination screenshot, actual executable under the chosen folder, version, successful local startup and bounded diagnostics. |
| Per-user to per-machine | Install the last per-user release to a D: folder, then run the new MSI. Uninstall the per-user copy quietly as documented in the desktop guide, then install the new MSI. | The new MSI refuses with the uninstall message while the per-user copy exists; after the quiet uninstall it installs; data in `%APPDATA%\RiA` is retained. |
| Offline startup | Disconnect external networking; keep loopback enabled. Restart and use stored chats, the task list, document search and a backup task run by hand. | Retained data and useful local output; model failures are explicit. |
| Upgrade | Install the preceding release; create a chat, attachment, to-do with a reminder and a schedule, document, backup and provider configuration. Close it including the tray process, install the new release, then reopen. Cover both the default destination and a directory on another local NTFS volume, and uninstall afterwards without dialogs reporting error 1926. On failure, retain an explicit `/L*V` installer log and read-only diagnostics from that VM before any remediation; record whether the same account was elevated. | Originals, document retrieval, settings and decryptable keys preserved; migration safety snapshot exists. Retain evidence of rollback behavior and any file-security failure. Do not record actual keys. |
| Installation directory changes | Back up, uninstall the MSI, reinstall it to another selected folder under the same Windows account. For a preceding Squirrel release, uninstall it before switching to MSI. | Data stays in `%APPDATA%\RiA`, chats and decryptable credentials are retained; no duplicate old shortcut or running installation remains. |
| Migration failure | On a copied VM workspace, simulate a failing migration. | Startup stops; pre-migration standalone SQLite snapshot includes committed WAL records. Recover from that snapshot before retry; retain original evidence. |
| Proxy | Configure a controlled HTTP proxy; restart the service; exercise a provider through it. Make the proxy unavailable, then remove it. | Proxy receives outbound traffic; loopback stays local; unavailable provider reports failure; removing proxy restores direct access. |
| Native notification | Enable Windows notifications and let a prompt task run; repeat with notifications suppressed. | One notification per run, a persisted application notice, click opens the app when displayed. Suppression is not reported as successful OS display. |
| Sleep/resume | Suspend with a task due during the sleep, then resume. Repeat with the local service interrupted and during app quit. | Healthy session and polling recover; unhealthy service has recovery; no duplicate task writes or automatic provider replay. Interrupted billing remains unknown. |
| Uninstall/reinstall | Back up first; put an unrelated sentinel file in the installation root, uninstall in the VM, inspect retained user data and sentinel, reinstall under the same Windows user. | MSI-owned files and shortcuts removed, sentinel and user data preserved. Never infer actual installer retention from an unpacked executable test. |
| Cancel installation | Open the destination page, choose another folder, cancel before installation. | No application installed or shortcuts registered. |
| In-app update | Serve a lower release a locally hosted, signed update manifest, the MSI and the Setup EXE. With an older updater, verify it still downloads and installs the MSI. With a Setup-aware updater, repeat from a non-default install path and check that RiA quits after download, the custom Setup progress window appears, and RiA restarts after install. Also test download cancellation, declining elevation, and cancellation while the custom installer is applying changes. | Both installers upgrade in place. The new version preserves workspaces and credentials and is the sole RiA entry in Windows Settings. Cancelled updates return to the previous version. An interrupted download never launches Setup. Retain the relevant logs and screenshots. |
| Update without disk space | Repeat an in-app update in the VM with less free space than the update needs. Cover the download volume and the system volume that stages and caches the installation. | RiA names the short volume and does not start the installer. Freeing space after an installer handoff was refused lets RiA retry a verified download. |
| Data location | With data in the default location, choose a folder on D: in **Settings › Storage** and move. Cancel once from the progress window, then move again to completion. Update in-app (as above), then uninstall and reinstall. Rename the D: folder and start RiA; choose **Choose the data folder…** and point it at the renamed folder. Move the data back to the default location and delete the old copy. | The copy shows progress and cancels with the data in place. After the move `%APPDATA%\RiA\data` is a junction to the D: folder, `data.moved-<time>` holds the old data, and chats, documents, media and decryptable keys are intact after the update and the reinstall. With the folder renamed, RiA asks instead of opening an empty workspace, and works again once pointed at it. Back home, the data is a real folder again and the deleted copy is gone. |
| Failed upgrade rollback | With the lower release installed, double-click this build's MSI and choose **Cancel** in its progress window once files are being copied. | Windows Installer rolls back: the lower release's folder, Start menu shortcut and entry in Apps & features are back, and it starts with data intact. An MSI built before the upgrade schedule changed leaves nothing installed in the same test; that is the defect this guards against. |

For the Windows application ID transition, exercise Upgrade and In-app update from a preceding MSI using `com.squirrel.RiA.RiA` to this release using `com.ria.RiA`. Verify the updated Start menu shortcut, taskbar grouping and RiA notification name/icon; record whether the old taskbar pin needed to be removed and pinned again. Recheck Windows notification preferences rather than assuming old settings or history migrated. These checks require an actual installed upgrade, not an unpacked executable.

Automated local evidence: isolated database migrations/WAL safety snapshots; settings encryption in Electron; reminder recording sink; resume state-machine tests; built-service offline local operations; real HTTP proxy forwarding and loopback bypass; unpacked/packaged smoke when explicitly run. These are separate from the manual scenarios above.

## Setup executable acceptance

Confirm that the Setup EXE and direct MSI both match the hashes in the release verification record. On a disposable Windows 10 or 11 VM:

| Required record entry | Procedure and evidence |
| --- | --- |
| `setup-clean-install` | Install from the EXE to the default path and to a custom local NTFS path. Check 100%, 150% and 200% scaling, keyboard focus, progress and the explicit launch action. After installation, rerun the same EXE and then a lower-version EXE. Capture the installed-version message and check the installed files stay unchanged. |
| `setup-upgrade-rollback` | Start with a previous standalone MSI installed to a custom location. Confirm Setup detects that location. Decline elevation in one run and cancel while Windows Installer applies changes in another, then verify the older release, shortcut and workspace. Complete the upgrade and verify it stays in place. During the in-app update test, also click the RiA shortcut while Setup is active and confirm the handoff finishes and RiA reopens only afterwards. |
| `setup-upgrade-uninstall` | Install through Setup, then update through an independent MSI built for a higher test version and select the existing folder in its wizard. Verify the upgrade stays in that folder. Uninstall through Windows Settings. Verify there was one public RiA entry, the program and shortcuts are gone, and user data plus an unrelated sentinel file are preserved. Reinstall through Setup and verify the workspace. Check that Setup did not register a Burn bundle or leave an MSI staged after success or cancellation. |

The preview exercises the window controls. The build validates the embedded MSI and exercises the real Setup refusal path without installing. The Windows workflow uses `scripts/test-setup-transaction.ps1 -PerMachine` to install isolated fixture MSIs using the same native API and verify upgrade, cancellation and registration rollback, uninstall and reinstall. The release acceptance uses the actual RiA artifacts with UAC enabled.

For the first Setup release, use a lower-version test build containing the Setup-aware updater for the EXE update scenario. Use the previous published MSI for the old updater scenario. A test feed with its own signing key requires a test build made with the corresponding public key.

The prerelease Burn prototype used a separate registration. If a test VM contains it, verify that version's own bundle uninstall only removes the bundle before using it for cleanup, or restore the VM snapshot. The current Setup and MSI leave existing Windows Installer registrations and third-party caches to their owners.

Release record template:

```text
Version / installer SHA-256:
Windows version / disposable VM identity:
Date / tester:
Scenario:
Result: pass | fail | not run
Evidence path / sanitized log:
Remaining issue:
```

For rollback, close the app and preserve the entire current user-data directory. A migration snapshot contains the database, not external media or DPAPI credentials; restore matching data/settings from a full backup or VM snapshot. Do not run an older executable against an upgraded database without a compatibility check. Portable backups exclude encrypted provider credentials and local daily model-call counters.
