import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  assertUpdateSettled, availableDataCopies, CACHE_MARKER_FILE, DATA_MARKER_FILE, DataLocationError, INCOMPLETE_MARKER_FILE, dataLocationStateFile,
  deleteDataCopy, forgetDataCopy, inspectDataRoot, loadDataLocationState, readDataLocationState, recognizeDataFolder, requestCacheMove, requestDataMove,
  resolveCacheRoot, runPendingCacheMove, runPendingDataMove, startEmptyWorkspace, switchToDataFolder, validateCacheTarget, validateMoveTarget,
  webCacheDirectory, writeDataLocationState, type DataLocationState, type PendingMove,
} from "../../electron/data-location";

const options = { databaseFileName: "app.db", freeSpace: async () => Number.MAX_SAFE_INTEGER };
const emptyState = (change: Partial<DataLocationState> = {}): DataLocationState => ({
  format: 1, pending: null, pendingCache: null, lastResult: null, linkedTarget: null, previousCopies: [], cache: null, cacheCleanup: [], lowSpaceHintAt: null, ...change,
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "ria-data-location-"));
  return { root, dataRoot: join(root, "data"), remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

/** A data folder as RiA leaves it: a migrated database, media in nested folders, a log. */
function seedData(folder: string, rows = 50) {
  mkdirSync(join(folder, "media", "workspace"), { recursive: true });
  mkdirSync(join(folder, "logs"), { recursive: true });
  const database = new DatabaseSync(join(folder, "app.db"));
  database.exec('CREATE TABLE "desktop_migrations" ("name" TEXT PRIMARY KEY); CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const insert = database.prepare("INSERT INTO notes (body) VALUES (?)");
  for (let index = 0; index < rows; index++) insert.run(`note ${index}`);
  database.close();
  writeFileSync(join(folder, "media", "workspace", "image.png"), Buffer.alloc(200_000, 7));
  writeFileSync(join(folder, "logs", "desktop.log"), "started\n");
}
function seedCache(folder: string) {
  mkdirSync(join(folder, "checkpoints", "blobs", "ab"), { recursive: true });
  mkdirSync(join(folder, "terminal-logs", "run-1"), { recursive: true });
  mkdirSync(join(folder, "chromium-cache"), { recursive: true });
  mkdirSync(join(folder, "ocr"), { recursive: true });
  writeFileSync(join(folder, "ocr", "document-1.pdf"), "scan waiting for OCR");
  writeFileSync(join(folder, "checkpoints", "blobs", "ab", "abcdef"), "undo copy");
  writeFileSync(join(folder, "terminal-logs", "run-1", "stdout.log"), "output");
  writeFileSync(join(folder, "chromium-cache", "index"), "web cache");
}
const noteCount = (folder: string) => {
  const database = new DatabaseSync(join(folder, "app.db"), { readOnly: true });
  try { return (database.prepare("SELECT count(*) AS count FROM notes").get() as { count: number }).count; } finally { database.close(); }
};
const isLink = (path: string) => lstatSync(path).isSymbolicLink();
const linkedTo = (dataRoot: string) => { const inspection = inspectDataRoot(dataRoot); return inspection.kind === "junction" ? inspection.target : null; };
const codeOf = async (promise: Promise<unknown> | (() => unknown)) => {
  try { await (typeof promise === "function" ? promise() : promise); return null; } catch (error) { return error instanceof DataLocationError ? error.code : String(error); }
};
async function moveTo(dataRoot: string, target: string) {
  await requestDataMove({ dataRoot, target, ...options });
  return runPendingDataMove(dataRoot, options);
}

test("the fixed path is read as a folder, a linked folder, or data that cannot be found", () => {
  const space = workspace();
  try {
    assert.deepEqual(inspectDataRoot(space.dataRoot), { kind: "absent" });
    mkdirSync(space.dataRoot);
    assert.equal(inspectDataRoot(space.dataRoot).kind, "directory");
    rmSync(space.dataRoot, { recursive: true });

    const elsewhere = join(space.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, space.dataRoot, "junction");
    assert.deepEqual(inspectDataRoot(space.dataRoot), { kind: "unavailable", expected: elsewhere, reason: "not-ria-data" }, "a folder without the marker is not taken for RiA data");
    writeFileSync(join(elsewhere, DATA_MARKER_FILE), "{}");
    assert.equal(inspectDataRoot(space.dataRoot).kind, "junction");
    renameSync(elsewhere, `${elsewhere}-unplugged`);
    assert.deepEqual(inspectDataRoot(space.dataRoot), { kind: "unavailable", expected: elsewhere, reason: "missing" });

    rmdirSync(space.dataRoot);
    assert.deepEqual(inspectDataRoot(space.dataRoot, emptyState({ linkedTarget: elsewhere })), { kind: "unavailable", expected: elsewhere, reason: "junction-missing" },
      "a removed junction is not mistaken for a fresh install");
    assert.deepEqual(inspectDataRoot(space.dataRoot, emptyState(), { recordLost: true }), { kind: "unavailable", expected: null, reason: "uncertain" },
      "with the record lost, a missing data folder may not be a fresh install");
    mkdirSync(`${space.dataRoot}.moved-20261117T000000Z`);
    assert.deepEqual(inspectDataRoot(space.dataRoot, emptyState()), { kind: "unavailable", expected: null, reason: "uncertain" },
      "data renamed aside beside the fixed path is not a fresh install");
  } finally { space.remove(); }
});

test("a data folder copied by hand is recognised by its database", () => {
  const space = workspace();
  try {
    const copied = join(space.root, "copied");
    seedData(copied);
    assert.equal(recognizeDataFolder(copied, "app.db"), "database");
    const unrelated = join(space.root, "unrelated");
    mkdirSync(unrelated);
    const other = new DatabaseSync(join(unrelated, "app.db"));
    other.exec("CREATE TABLE something (id INTEGER)");
    other.close();
    assert.equal(recognizeDataFolder(unrelated, "app.db"), null, "another program's app.db is not RiA data");
    writeFileSync(join(unrelated, DATA_MARKER_FILE), "{}");
    assert.equal(recognizeDataFolder(unrelated, "app.db"), "marked");
  } finally { space.remove(); }
});

test("a target is refused when it cannot hold the data, and checking it leaves nothing behind", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot);
    const check = (target: string, extra: Partial<typeof options> = {}) => codeOf(validateMoveTarget({ dataRoot: space.dataRoot, target, ...options, ...extra }));
    assert.equal(await check("relative\\folder"), "not-absolute");
    assert.equal(await check("\\\\server\\share\\RiA"), "network-path");
    assert.equal(await check(space.dataRoot), "same-location");
    assert.equal(await check(join(space.dataRoot, "inside")), "nested");
    assert.equal(await check(space.root), "nested");
    const occupied = join(space.root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "personal.txt"), "mine");
    assert.equal(await check(occupied), "not-empty");
    assert.equal(await check(join(space.root, "full-drive"), { freeSpace: async () => 1024 }), "insufficient-space");
    assert.equal(existsSync(join(space.root, "full-drive")), false, "a refused target that did not exist is not left created");

    const fresh = join(space.root, "new", "nested", "target");
    const checked = await validateMoveTarget({ dataRoot: space.dataRoot, target: fresh, ...options });
    assert.equal(checked.mode, "copy");
    assert.ok(checked.dataBytes > 200_000 && checked.requiredBytes > checked.dataBytes);
    assert.equal(existsSync(join(space.root, "new")), false, "the probe removes the folders it created");
    assert.deepEqual(readdirSync(space.root).sort(), ["data", "occupied"], "no probe junction or file is left beside the data");

    const byHand = join(space.root, "by-hand");
    seedData(byHand);
    assert.equal((await validateMoveTarget({ dataRoot: space.dataRoot, target: byHand, ...options })).mode, "adopt", "a folder holding RiA data is used as it is");
  } finally { space.remove(); }
});

test("a move copies and verifies everything, links the fixed path to it and keeps the old folder", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot, 120);
    mkdirSync(join(space.dataRoot, "chromium-cache"));
    writeFileSync(join(space.dataRoot, "chromium-cache", "index"), "web cache");
    const target = join(space.root, "D-drive", "RiA");
    const pending = await requestDataMove({ dataRoot: space.dataRoot, target, ...options });
    assert.equal(pending.phase, "requested");
    assert.equal(await codeOf(requestDataMove({ dataRoot: space.dataRoot, target, ...options })), "move-pending");

    const phases = new Set<string>();
    const result = await runPendingDataMove(space.dataRoot, { ...options, onProgress: progress => phases.add(progress.phase) });
    assert.equal(result?.outcome, "moved");
    assert.deepEqual([...phases], ["database", "verifying", "files", "switching"]);
    assert.ok(isLink(space.dataRoot));
    assert.equal(linkedTo(space.dataRoot), target);
    assert.equal(noteCount(space.dataRoot), 120, "the database opens through the fixed path");
    assert.deepEqual(readFileSync(join(space.dataRoot, "media", "workspace", "image.png")), Buffer.alloc(200_000, 7));
    assert.equal(existsSync(join(target, "chromium-cache")), false, "the web cache is not copied; it is rebuilt");
    assert.equal(existsSync(join(target, INCOMPLETE_MARKER_FILE)), false);

    const state = readDataLocationState(space.dataRoot);
    assert.equal(state.pending, null);
    assert.equal(state.linkedTarget, target);
    const [old] = state.previousCopies;
    assert.match(old.path, /data\.moved-\d{8}T\d{6}Z(?:-\d+)?$/);
    assert.equal(noteCount(old.path), 120, "the old folder is kept, untouched");

    writeFileSync(join(space.dataRoot, "logs", "after.log"), "written after the move");
    assert.ok(existsSync(join(target, "logs", "after.log")), "new writes land in the new folder");
    assert.equal(await runPendingDataMove(space.dataRoot, options), null, "a finished move does not run again");
  } finally { space.remove(); }
});

test("linked data can move again, come back to the fixed path, or be adopted where a copy already is", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot, 30);
    const first = join(space.root, "first");
    const second = join(space.root, "second");
    await moveTo(space.dataRoot, first);
    assert.equal((await moveTo(space.dataRoot, second))?.outcome, "moved");
    assert.equal(linkedTo(space.dataRoot), second);
    assert.equal(noteCount(first), 30, "the folder moved away from stays as it was");
    assert.ok(readDataLocationState(space.dataRoot).previousCopies.some(copy => copy.path === first));

    assert.equal((await moveTo(space.dataRoot, space.dataRoot))?.outcome, "moved");
    assert.equal(isLink(space.dataRoot), false, "back home the data is a real folder again");
    assert.equal(noteCount(space.dataRoot), 30);
    assert.equal(readDataLocationState(space.dataRoot).linkedTarget, null);
    assert.ok(!readdirSync(space.root).some(name => name.includes(".incoming-")), "no staging folder is left");

    await requestDataMove({ dataRoot: space.dataRoot, target: second, ...options });
    assert.equal(readDataLocationState(space.dataRoot).pending!.mode, "adopt");
    assert.equal((await runPendingDataMove(space.dataRoot, options))?.outcome, "moved");
    assert.equal(linkedTo(space.dataRoot), second);

    const byHand = join(space.root, "by-hand");
    seedData(byHand, 7);
    assert.equal((await moveTo(space.dataRoot, byHand))?.outcome, "moved");
    assert.equal(noteCount(space.dataRoot), 7);
    assert.ok(existsSync(join(byHand, DATA_MARKER_FILE)), "a folder adopted without a marker gets one");
  } finally { space.remove(); }
});

test("a failed or cancelled copy leaves the data in place and removes only the partial copy it made", async () => {
  const space = workspace();
  try {
    mkdirSync(space.dataRoot);
    // Not a database: the backup fails after the copy has begun.
    writeFileSync(join(space.dataRoot, "app.db"), "this is not a database");
    writeFileSync(join(space.dataRoot, "keep.txt"), "kept");
    const target = join(space.root, "target");
    const result = await moveTo(space.dataRoot, target);
    assert.equal(result?.outcome, "failed");
    assert.equal(existsSync(target), false, "the folder the move created is removed");
    assert.equal(isLink(space.dataRoot), false);
    assert.equal(readFileSync(join(space.dataRoot, "keep.txt"), "utf8"), "kept");
    assert.equal(readDataLocationState(space.dataRoot).pending, null);

    rmSync(space.dataRoot, { recursive: true });
    seedData(space.dataRoot);
    const chosen = join(space.root, "chosen-empty");
    mkdirSync(chosen);
    await requestDataMove({ dataRoot: space.dataRoot, target: chosen, ...options });
    const controller = new AbortController();
    const cancelled = await runPendingDataMove(space.dataRoot, { ...options, signal: controller.signal, onProgress: progress => { if (progress.phase === "files") controller.abort(); } });
    assert.equal(cancelled?.outcome, "cancelled");
    assert.deepEqual(readdirSync(chosen), [], "a folder the person chose is emptied of the copy but kept");
    assert.equal(isLink(space.dataRoot), false);
    assert.equal(noteCount(space.dataRoot), 50);
  } finally { space.remove(); }
});

test("a start after a crash discards an unfinished copy and never touches a folder that is not one", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot);
    const target = join(space.root, "target");
    const crashed = (pending: Partial<PendingMove>) => writeDataLocationState(space.dataRoot, emptyState({
      pending: { id: "crash", target, mode: "copy", requestedAt: new Date().toISOString(), phase: "copying", createdTarget: true, ...pending },
    }));

    mkdirSync(join(target, "media"), { recursive: true });
    writeFileSync(join(target, INCOMPLETE_MARKER_FILE), "");
    writeFileSync(join(target, "media", "half.png"), "half");
    crashed({});
    assert.equal((await runPendingDataMove(space.dataRoot, options))?.outcome, "interrupted");
    assert.equal(existsSync(target), false);
    assert.equal(noteCount(space.dataRoot), 50);

    mkdirSync(target);
    writeFileSync(join(target, "personal.txt"), "not RiA's");
    crashed({});
    await runPendingDataMove(space.dataRoot, options);
    assert.equal(readFileSync(join(target, "personal.txt"), "utf8"), "not RiA's", "without the incomplete marker nothing is deleted");
  } finally { space.remove(); }
});

test("a crash in the middle of the switch is finished, undone, or held for the person when neither is possible", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot);
    const target = join(space.root, "target");
    const setAside = `${space.dataRoot}.moved-20261117T000000Z`;
    const switching = (): DataLocationState => emptyState({ pending: { id: "crash", target, mode: "copy", requestedAt: new Date().toISOString(), phase: "switching", createdTarget: true, switchKind: "set-aside", setAside } });

    // The copy finished and the old folder was renamed aside; the junction was never made.
    seedData(target);
    writeFileSync(join(target, DATA_MARKER_FILE), "{}");
    renameSync(space.dataRoot, setAside);
    writeDataLocationState(space.dataRoot, switching());
    assert.equal((await runPendingDataMove(space.dataRoot, options))?.outcome, "moved");
    assert.equal(noteCount(space.dataRoot), 50);

    // The copy never got its marker: the old folder is put back.
    rmdirSync(space.dataRoot);
    rmSync(join(target, DATA_MARKER_FILE));
    writeFileSync(join(target, INCOMPLETE_MARKER_FILE), "");
    writeDataLocationState(space.dataRoot, switching());
    assert.equal((await runPendingDataMove(space.dataRoot, options))?.outcome, "failed");
    assert.equal(isLink(space.dataRoot), false, "the old folder is put back");
    assert.equal(noteCount(space.dataRoot), 50);

    // Neither: the old folder was moved elsewhere by hand and the copy is not whole. The record is kept and the start must ask.
    const elsewhere = join(space.root, "moved-by-hand");
    renameSync(space.dataRoot, elsewhere);
    writeDataLocationState(space.dataRoot, switching());
    assert.equal(await codeOf(runPendingDataMove(space.dataRoot, options)), "unrecoverable");
    const kept = readDataLocationState(space.dataRoot);
    assert.equal(kept.pending?.phase, "switching", "the record stays so a retry can finish it");
    assert.equal(inspectDataRoot(space.dataRoot, kept).kind, "unavailable", "no empty workspace is started in its place");

    // The person points RiA at where the data really is; the abandoned move is cleared.
    switchToDataFolder(space.dataRoot, elsewhere, "app.db");
    assert.equal(linkedTo(space.dataRoot), elsewhere);
    assert.equal(noteCount(space.dataRoot), 50);
    assert.equal(readDataLocationState(space.dataRoot).pending, null);
    assert.ok(existsSync(join(elsewhere, DATA_MARKER_FILE)), "a folder picked without a marker gets one");
  } finally { space.remove(); }
});

test("when the linked folder is gone, a copy, another folder or an empty workspace can be chosen, and nothing is deleted", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot, 10);
    const usb = join(space.root, "usb");
    await moveTo(space.dataRoot, usb);
    renameSync(usb, `${usb}-unplugged`);
    assert.equal(inspectDataRoot(space.dataRoot).kind, "unavailable");

    // An earlier copy: the folder set aside beside the fixed path is renamed back.
    const [copy] = availableDataCopies(space.dataRoot, readDataLocationState(space.dataRoot), "app.db");
    assert.equal(copy.source, "earlier");
    switchToDataFolder(space.dataRoot, copy.path, "app.db");
    assert.equal(isLink(space.dataRoot), false);
    assert.equal(noteCount(space.dataRoot), 10);

    // The drive letter changed: the data is found under its new path and linked again.
    await moveTo(space.dataRoot, join(space.root, "E-drive"));
    renameSync(join(space.root, "E-drive"), join(space.root, "F-drive"));
    assert.equal(await codeOf(() => switchToDataFolder(space.dataRoot, join(space.root, "nothing-here"), "app.db")), "not-directory");
    const unrelated = join(space.root, "unrelated");
    mkdirSync(unrelated);
    assert.equal(await codeOf(() => switchToDataFolder(space.dataRoot, unrelated, "app.db")), "not-ria-data");
    switchToDataFolder(space.dataRoot, join(space.root, "F-drive"), "app.db");
    assert.equal(linkedTo(space.dataRoot), join(space.root, "F-drive"));

    // Starting empty: the folder that went missing stays on the list to switch back to later.
    renameSync(join(space.root, "F-drive"), join(space.root, "F-gone"));
    startEmptyWorkspace(space.dataRoot);
    assert.equal(isLink(space.dataRoot), false);
    assert.deepEqual(readdirSync(space.dataRoot), []);
    const state = readDataLocationState(space.dataRoot);
    assert.equal(state.linkedTarget, null);
    assert.ok(state.previousCopies.some(entry => entry.path === join(space.root, "F-drive")));
    assert.ok(existsSync(join(space.root, "F-gone", "app.db")), "the data itself is untouched");
  } finally { space.remove(); }
});

test("a damaged record is set aside and the start goes on; a newer one stops it", () => {
  const space = workspace();
  try {
    mkdirSync(space.dataRoot);
    writeFileSync(dataLocationStateFile(space.dataRoot), "{ not json");
    assert.throws(() => readDataLocationState(space.dataRoot), (error: unknown) => error instanceof DataLocationError && error.code === "state-unreadable");
    const loaded = loadDataLocationState(space.dataRoot);
    assert.ok(loaded.recordLost && existsSync(loaded.recordLost), "the damaged record is kept for diagnosis");
    assert.equal(existsSync(dataLocationStateFile(space.dataRoot)), false);
    assert.equal(inspectDataRoot(space.dataRoot, loaded.state, { recordLost: true }).kind, "directory", "data that is there still opens");

    writeFileSync(dataLocationStateFile(space.dataRoot), JSON.stringify({ format: 2, pending: { phase: "switching" } }));
    assert.throws(() => loadDataLocationState(space.dataRoot), (error: unknown) => error instanceof DataLocationError && error.code === "state-newer");

    for (const phase of ["downloading", "ready", "installing"]) {
      assert.throws(() => assertUpdateSettled(phase), (error: unknown) => error instanceof DataLocationError && error.code === "update-in-progress");
    }
    for (const phase of [null, "idle", "checking", "current", "available"]) assert.doesNotThrow(() => assertUpdateSettled(phase));
  } finally { space.remove(); }
});

test("the cache moves to its own folder and back, carrying undo copies, terminal output and scans waiting for OCR but not the web cache", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot);
    seedCache(space.dataRoot);
    const cache = join(space.root, "cache-drive", "RiA cache");
    assert.equal(await codeOf(validateCacheTarget({ dataRoot: space.dataRoot, target: join(space.dataRoot, "cache") })), "nested");
    assert.equal(await codeOf(validateCacheTarget({ dataRoot: space.dataRoot, target: null })), "same-location");

    const webCacheInUse = webCacheDirectory(space.dataRoot, readDataLocationState(space.dataRoot));
    await requestCacheMove({ dataRoot: space.dataRoot, target: cache });
    assert.equal(await codeOf(requestDataMove({ dataRoot: space.dataRoot, target: join(space.root, "x"), ...options })), "move-pending", "one move at a time");
    const result = await runPendingCacheMove(space.dataRoot, { webCacheInUse });
    assert.equal(result?.outcome, "moved");
    assert.equal(readFileSync(join(cache, "checkpoints", "blobs", "ab", "abcdef"), "utf8"), "undo copy");
    assert.equal(readFileSync(join(cache, "terminal-logs", "run-1", "stdout.log"), "utf8"), "output");
    assert.equal(readFileSync(join(cache, "ocr", "document-1.pdf"), "utf8"), "scan waiting for OCR");
    assert.equal(existsSync(join(space.dataRoot, "ocr")), false, "the old scans go once the new copies are in place");
    assert.ok(existsSync(join(cache, CACHE_MARKER_FILE)));
    assert.equal(existsSync(join(space.dataRoot, "checkpoints")), false, "the old undo copies are removed once the new ones are in place");
    assert.ok(existsSync(join(space.dataRoot, "chromium-cache")), "the web cache Chromium is using this run is left until the next start");
    assert.deepEqual(resolveCacheRoot(space.dataRoot, readDataLocationState(space.dataRoot)), { path: cache, custom: true, unavailable: null });

    // The next start removes the old web cache.
    await runPendingCacheMove(space.dataRoot, { webCacheInUse: join(cache, "chromium-cache") });
    assert.equal(existsSync(join(space.dataRoot, "chromium-cache")), false);

    // A cache folder that cannot be found falls back to the data folder for the run; the choice is kept.
    renameSync(cache, `${cache}-unplugged`);
    assert.deepEqual(resolveCacheRoot(space.dataRoot, readDataLocationState(space.dataRoot)), { path: space.dataRoot, custom: false, unavailable: cache });
    renameSync(`${cache}-unplugged`, cache);

    await requestCacheMove({ dataRoot: space.dataRoot, target: null });
    assert.equal((await runPendingCacheMove(space.dataRoot, {}))?.outcome, "moved");
    assert.equal(readFileSync(join(space.dataRoot, "checkpoints", "blobs", "ab", "abcdef"), "utf8"), "undo copy");
    assert.equal(readDataLocationState(space.dataRoot).cache, null);
    assert.equal(existsSync(join(cache, "checkpoints")), false);
  } finally { space.remove(); }
});

test("only copies RiA left behind can be deleted, never the data in use", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot);
    const target = join(space.root, "target");
    await moveTo(space.dataRoot, target);
    const [copy] = readDataLocationState(space.dataRoot).previousCopies;

    assert.equal(await codeOf(deleteDataCopy(space.dataRoot, target)), "not-a-copy", "the data in use is not on the list");
    // A tampered record that lists the data in use, or an unrelated folder, is still refused.
    const unrelated = join(space.root, "personal");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "mine.txt"), "mine");
    const state = readDataLocationState(space.dataRoot);
    writeDataLocationState(space.dataRoot, { ...state, previousCopies: [...state.previousCopies, { path: target, at: "" }, { path: unrelated, at: "" }] });
    assert.equal(await codeOf(deleteDataCopy(space.dataRoot, target)), "in-current-use");
    assert.equal(await codeOf(deleteDataCopy(space.dataRoot, unrelated)), "not-a-copy");
    assert.ok(existsSync(join(unrelated, "mine.txt")));
    assert.equal(await codeOf(() => forgetDataCopy(space.dataRoot, copy.path)), "in-current-use", "a copy that still exists is deleted, not forgotten");

    await deleteDataCopy(space.dataRoot, copy.path);
    assert.equal(existsSync(copy.path), false);
    assert.equal(noteCount(space.dataRoot), 50, "the data in use is untouched");
    assert.ok(!readDataLocationState(space.dataRoot).previousCopies.some(entry => entry.path === copy.path));
  } finally { space.remove(); }
});

test("undo copies made while a chosen cache folder was missing are carried, not lost, when the cache moves again", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot);
    const cache = join(space.root, "E-cache");
    await requestCacheMove({ dataRoot: space.dataRoot, target: cache });
    await runPendingCacheMove(space.dataRoot, {});
    renameSync(cache, `${cache}-unplugged`);
    // Meanwhile RiA keeps the cache in the data folder and writes an undo copy there.
    seedCache(space.dataRoot);
    const fresh = join(space.root, "F-cache");
    await requestCacheMove({ dataRoot: space.dataRoot, target: fresh });
    assert.equal((await runPendingCacheMove(space.dataRoot, {}))?.outcome, "moved");
    assert.equal(readFileSync(join(fresh, "checkpoints", "blobs", "ab", "abcdef"), "utf8"), "undo copy");
    assert.equal(existsSync(join(space.dataRoot, "checkpoints")), false);
  } finally { space.remove(); }
});

test("the data cannot be moved into the cache folder, and a kept copy can be switched back to", async () => {
  const space = workspace();
  try {
    seedData(space.dataRoot, 4);
    const cache = join(space.root, "cache");
    await requestCacheMove({ dataRoot: space.dataRoot, target: cache });
    await runPendingCacheMove(space.dataRoot, {});
    assert.equal(await codeOf(validateMoveTarget({ dataRoot: space.dataRoot, target: join(cache, "data"), ...options })), "nested");

    const usb = join(space.root, "usb");
    await moveTo(space.dataRoot, usb);
    renameSync(usb, `${usb}-unplugged`);
    startEmptyWorkspace(space.dataRoot);
    const left = readDataLocationState(space.dataRoot).previousCopies.find(copy => copy.path === usb);
    assert.equal(left?.reason, "left", "the data that could not be found is told apart from an old copy");
    assert.equal(readDataLocationState(space.dataRoot).previousCopies.find(copy => copy.path.includes(".moved-"))?.reason, "moved");

    // The drive is back: switching to it uses the data as it is and takes it off the list.
    renameSync(`${usb}-unplugged`, usb);
    assert.equal((await moveTo(space.dataRoot, usb))?.outcome, "moved");
    assert.equal(noteCount(space.dataRoot), 4);
    const after = readDataLocationState(space.dataRoot).previousCopies;
    assert.ok(!after.some(copy => copy.path === usb), "the data in use is no longer listed as a copy");
    assert.ok(after.some(copy => copy.reason === "moved" && readdirSync(copy.path).length === 0), "the empty workspace it replaced is kept as a copy");
  } finally { space.remove(); }
});
