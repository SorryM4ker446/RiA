# Windows release acceptance

Run installation and upgrade checks in a disposable Windows VM, under the same Windows user for DPAPI-encrypted settings. Do not install a test build over a personal workspace. Signing and automatic updates are outside the current release process.

Record the installer version, SHA-256 from `verification.json`, Windows build, installation type, tester and date. A checksum identifies an artifact; it does not prove publisher authenticity. Generated manifests mark manual checks unverified until a tester records evidence.

Initialize the structured acceptance record after building the MSI:

```powershell
npm run desktop:acceptance -- --init
```

This reads `out/make/wix/x64/verification.json`, verifies the actual MSI size and SHA-256, and creates `acceptance.json` beside it. Every scenario starts as `not-run`; initialization fails rather than overwriting an existing record. CI uploads this unverified template together with the MSI and checksum manifest. Keep older records and evidence in their own release directory; if rebuilding an undistributed version, archive its old record before initializing a fresh one. A same-version rebuild with different installer bytes invalidates the old acceptance.

Fill `environment.windowsBuild`, `vm` (disposable VM identity), `installationType`, `tester`, and `previousVersion` (the lower release used for upgrade). For each of the ten scenarios below, set `result` to `pass`, `fail` or `not-run`, `testedAt` to a UTC ISO timestamp (for example `2026-10-07T08:30:00Z`), and `evidence` to one or more nonempty file paths. Relative paths are resolved from the acceptance record's directory; absolute paths are also supported. Use screenshots and sanitized logs, never provider keys, passwords or connection strings. Do not use the installer, checksum manifest or acceptance record itself as scenario evidence.

After performing and reviewing every scenario, verify the completed record:

```powershell
npm run desktop:acceptance -- --check --output out/make/wix/x64/acceptance-verified.json
```

The check rejects changed installer bytes/version, missing or duplicate scenarios, failed/unperformed results, missing environment information, invalid/future timestamps, and missing/empty evidence. It creates a receipt with SHA-256 hashes of the record and evidence files, without copying their contents. Existing output files are preserved; choose a new receipt filename for a later check. Omitting `--output` prints the JSON receipt without writing a file. `--manifest <path>` and `--record <path>` allow checking an archived release outside this checkout.

`verification.json` remains the artifact identity record with initial unverified placeholders; `acceptance.json` is the tester's manual result record. A passing check validates those attestations and their file references, not screenshot contents, publisher identity, or whether a physical test actually occurred. Keep the receipt with the exact MSI and reviewed evidence, and use the CI logs separately for automated build/package/smoke results. This command neither installs software nor publishes artifacts.

| Scenario | Procedure | Evidence required |
| --- | --- | --- |
| Clean installation | Install the built MSI in a clean VM without Node/npm or repository files. Use the Chinese wizard's destination Browse control to choose a writable D: folder, including spaces and Chinese characters. Launch from Start menu. | Destination screenshot, actual executable under the chosen folder, version, successful local startup and bounded diagnostics. |
| Offline startup | Disconnect external networking; keep loopback enabled. Restart and use stored chats, manual tasks, document search and backup. | Retained data and useful local output; model failures are explicit. |
| Upgrade | Install the preceding release; create a chat, attachment, task/reminder, document, backup and provider configuration. Close it, install the new release under the same Windows account, then reopen. | Originals, document retrieval, settings and decryptable keys preserved; migration safety snapshot exists. Do not record actual keys. |
| Installation directory changes | Back up, uninstall the MSI, reinstall it to another selected folder under the same Windows account. For a preceding Squirrel release, uninstall it before switching to MSI. | Data stays in `%APPDATA%\RiA`, chats and decryptable credentials are retained; no duplicate old shortcut or running installation remains. |
| Migration failure | On a copied VM workspace, simulate a failing migration. | Startup stops; pre-migration standalone SQLite snapshot includes committed WAL records. Recover from that snapshot before retry; retain original evidence. |
| Proxy | Configure a controlled HTTP proxy; restart the service; exercise a provider through it. Make the proxy unavailable, then remove it. | Proxy receives outbound traffic; loopback stays local; unavailable provider reports failure; removing proxy restores direct access. |
| Native notification | Enable Windows notifications and a due task; repeat with notifications suppressed. | At most one claim, a persisted application notice, click opens the app when displayed. Suppression is not reported as successful OS display. |
| Sleep/resume | Suspend with a due reminder, then resume. Repeat with the local service interrupted and during app quit. | Healthy session and polling recover; unhealthy service has recovery; no duplicate task writes or automatic provider replay. Interrupted billing remains unknown. |
| Uninstall/reinstall | Back up first; put an unrelated sentinel file in the installation root, uninstall in the VM, inspect retained user data and sentinel, reinstall under the same Windows user. | MSI-owned files and shortcuts removed, sentinel and user data preserved. Never infer actual installer retention from an unpacked executable test. |
| Cancel installation | Open the destination page, choose another folder, cancel before installation. | No application installed or shortcuts registered. |

Automated local evidence: isolated database migrations/WAL safety snapshots; settings encryption in Electron; reminder recording sink; resume state-machine tests; built-service offline local operations; real HTTP proxy forwarding and loopback bypass; unpacked/packaged smoke when explicitly run. These are separate from the manual scenarios above.

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
