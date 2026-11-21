import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { bindTerminalApproval, runTerminalCommand } = await import("@/lib/terminal/runtime");
const { captureFileSnapshot, keptSnapshotHashes } = await import("@/lib/terminal/file-changes");
const { applyProjectEdit, bindProjectEdit } = await import("@/lib/project-files/service");
const { contentHash } = await import("@/lib/project-files/text");
const { applyRedo, applyUndo, previewRedo, previewUndo, takeUndoContext, undoStates } = await import("@/lib/checkpoints/undo");
const { pruneCheckpoints } = await import("@/lib/checkpoints/prune");
const { commitFile } = await import("@/lib/checkpoints/commit");
const { writeGitBlob } = await import("@/lib/checkpoints/git");
const { withFileWriteLock } = await import("@/lib/local-files/file-writes");
const { hasBlob, putBlob, readBlob, saveStoreLimit, sha256, checkpointRoot } = await import("@/lib/checkpoints/store");
const preferencesRoute = await import("@/app/api/checkpoint-preferences/route");
const undoRoute = await import("@/app/api/conversations/[id]/undo/route");

const roots: string[] = [];
const win = process.platform === "win32";

async function workspace() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-checkpoints-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  const chat = await db.chat.create({ data: { title: "Undo", workspaceGrantId: grant.id } });
  const run = await db.agentRun.create({ data: { chatId: chat.id, status: "running", goal: "Undo test" } });
  return { root, grantId: grant.id, chatId: chat.id, runId: run.id };
}
const command = async (where: { grantId: string; chatId: string; runId: string }, text: string) =>
  runTerminalCommand(await bindTerminalApproval({ grantId: where.grantId, command: text }), undefined, where.runId, { chatId: where.chatId });
const undoRequest = (chatId: string, body: unknown) => undoRoute.POST(new NextRequest(`http://localhost/api/conversations/${chatId}/undo`, {
  method: "POST", headers: { host: "localhost", cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: chatId }) });

beforeEach((t: TestContext) => {
  process.env.APP_RUNTIME = "test";
  globalThis.__riaRateLimitStore?.clear();
  t.mock.method(console, "error", () => {});
});
after(async () => {
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== realpathSync.native(tmpdir()) || !path.basename(root).startsWith("ria-checkpoints-")) throw new Error("Unexpected checkpoint test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});

test("a command's changes are undone file by file: modified content returns, a created file goes, a deleted one comes back", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "notes.txt"), "before\n");
  writeFileSync(path.join(where.root, "old.txt"), "keep me\n");
  const result = await command(where, win
    ? "[IO.File]::WriteAllText('notes.txt', \"after`n\"); New-Item -ItemType Directory -Path 'made' | Out-Null; [IO.File]::WriteAllText('made/new.txt', 'new'); Remove-Item -LiteralPath 'old.txt'"
    : "printf 'after\\n' > notes.txt; mkdir made; printf new > made/new.txt; rm old.txt");
  assert.equal(result.status, "completed", result.stderr);
  const rows = await db.fileCheckpoint.findMany({ where: { chatId: where.chatId }, orderBy: { path: "asc" } });
  assert.deepEqual(rows.map(row => [row.path, row.kind, row.source, row.restorable]), [
    ["made/new.txt", "created", "terminal", true], ["notes.txt", "modified", "terminal", true], ["old.txt", "deleted", "terminal", true],
  ]);
  assert.ok(rows.every(row => row.runId === where.runId && row.root === where.root));

  const preview = await previewUndo(where.chatId, [where.runId]);
  assert.deepEqual(preview.map(item => [item.path, item.action, item.status]).sort(), [
    ["made/new.txt", "delete", "ready"], ["notes.txt", "restore", "ready"], ["old.txt", "recreate", "ready"],
  ]);
  // A preview changes nothing.
  assert.equal(readFileSync(path.join(where.root, "notes.txt"), "utf8"), "after\n");

  const undone = await applyUndo(where.chatId, [where.runId]);
  assert.ok(undone.every(item => item.status === "undone"), JSON.stringify(undone));
  assert.equal(readFileSync(path.join(where.root, "notes.txt"), "utf8"), "before\n");
  assert.equal(readFileSync(path.join(where.root, "old.txt"), "utf8"), "keep me\n");
  assert.equal(existsSync(path.join(where.root, "made", "new.txt")), false);
  assert.ok((await db.fileCheckpoint.findMany({ where: { chatId: where.chatId } })).every(row => row.undoneAt));
  // Once undone there is nothing left, and the next turn is told what the user took back.
  assert.deepEqual(await previewUndo(where.chatId, [where.runId]), []);
  const note = takeUndoContext(where.chatId);
  assert.match(note, /notes\.txt/);
  assert.match(note, /old\.txt/);
  assert.equal(takeUndoContext(where.chatId), "", "the note is told once");
});

test("a file changed after the turn is left alone and reported, while the others are undone", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "a.txt"), "a1");
  writeFileSync(path.join(where.root, "b.txt"), "b1");
  await command(where, win ? "[IO.File]::WriteAllText('a.txt', 'a2'); [IO.File]::WriteAllText('b.txt', 'b2')" : "printf a2 > a.txt; printf b2 > b.txt");
  writeFileSync(path.join(where.root, "b.txt"), "edited by the user");
  const results = await applyUndo(where.chatId, [where.runId]);
  assert.deepEqual(Object.fromEntries(results.map(item => [item.path, item.status])), { "a.txt": "undone", "b.txt": "changed" });
  assert.equal(readFileSync(path.join(where.root, "a.txt"), "utf8"), "a1");
  assert.equal(readFileSync(path.join(where.root, "b.txt"), "utf8"), "edited by the user");
  // The file that was left keeps its row, so it is still reported, not silently dropped.
  assert.deepEqual((await previewUndo(where.chatId, [where.runId])).map(item => [item.path, item.status]), [["b.txt", "changed"]]);
});

test("several runs on one file go back to before the first, and edits made with the file tool are undone too", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "math.ts"), "export const x = 1;\n");
  const first = await bindProjectEdit({ grantId: where.grantId, path: "math.ts", expectedHash: contentHash(readFileSync(path.join(where.root, "math.ts"))), edits: [{ oldText: "1", newText: "2" }] });
  await applyProjectEdit(first, undefined, { chatId: where.chatId, runId: where.runId });
  const second = await db.agentRun.create({ data: { chatId: where.chatId, status: "running", goal: "Undo test" } });
  await command({ ...where, runId: second.id }, win ? "[IO.File]::WriteAllText('math.ts', \"export const x = 3;`n\")" : "printf 'export const x = 3;\\n' > math.ts");
  assert.equal(readFileSync(path.join(where.root, "math.ts"), "utf8"), "export const x = 3;\n");
  const rows = await db.fileCheckpoint.findMany({ where: { chatId: where.chatId }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map(row => row.source), ["edit", "terminal"]);
  // Undoing only the later run puts back what the edit wrote.
  assert.deepEqual((await applyUndo(where.chatId, [second.id])).map(item => item.status), ["undone"]);
  assert.equal(readFileSync(path.join(where.root, "math.ts"), "utf8"), "export const x = 2;\n");
  // A file the edit tool created is deleted again.
  const created = await bindProjectEdit({ grantId: where.grantId, path: "fresh.md", content: "# New\n" });
  await applyProjectEdit(created, undefined, { chatId: where.chatId, runId: where.runId });
  const results = await applyUndo(where.chatId, [where.runId]);
  assert.deepEqual(Object.fromEntries(results.map(item => [item.path, [item.action, item.status]])), { "math.ts": ["restore", "undone"], "fresh.md": ["delete", "undone"] });
  assert.equal(readFileSync(path.join(where.root, "math.ts"), "utf8"), "export const x = 1;\n");
  assert.equal(existsSync(path.join(where.root, "fresh.md")), false);
});

test("a command outside a conversation records nothing, and a walk with keep stores each file once by content", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "one.txt"), "same");
  writeFileSync(path.join(where.root, "two.txt"), "same");
  await runTerminalCommand(await bindTerminalApproval({ grantId: where.grantId, command: win ? "[IO.File]::WriteAllText('one.txt', 'other')" : "printf other > one.txt" }));
  assert.equal(await db.fileCheckpoint.count({ where: { grantId: where.grantId } }), 0);
  const snapshot = await captureFileSnapshot(where.root, Infinity, { keep: true });
  assert.equal(snapshot.files.get("two.txt")?.kept, true);
  assert.equal(await hasBlob(sha256(Buffer.from("same"))), true);
  assert.ok(keptSnapshotHashes().has(sha256(Buffer.from("other"))));
  // An unchanged file is not read again: the next walk reuses the same observation.
  const again = await captureFileSnapshot(where.root, Infinity, { keep: true });
  assert.equal(again.files.get("two.txt"), snapshot.files.get("two.txt"));
});

test("pruning drops expired rows and content nothing needs, and revoking a folder drops its checkpoints", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "p.txt"), "first");
  await command(where, win ? "[IO.File]::WriteAllText('p.txt', 'second')" : "printf second > p.txt");
  const orphan = await putBlob(Buffer.from(`orphan ${Date.now()}`));
  const blobFile = path.join(checkpointRoot(), "blobs", orphan.slice(0, 2), orphan);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(blobFile, old, old);
  await db.fileCheckpoint.updateMany({ where: { chatId: where.chatId }, data: { createdAt: new Date(Date.now() - 15 * 24 * 60 * 60_000) } });
  await pruneCheckpoints();
  assert.equal(await db.fileCheckpoint.count({ where: { chatId: where.chatId } }), 0, "rows past the retention go");
  assert.equal(await hasBlob(orphan), false, "content nothing refers to goes");

  await command(where, win ? "[IO.File]::WriteAllText('p.txt', 'third')" : "printf third > p.txt");
  assert.equal(await db.fileCheckpoint.count({ where: { grantId: where.grantId } }), 1);
  await revokeGrant(where.grantId);
  assert.equal(await db.fileCheckpoint.count({ where: { grantId: where.grantId } }), 0);
});

test("the undo route previews without changing anything, applies on request and validates its input", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "r.txt"), "one");
  await command(where, win ? "[IO.File]::WriteAllText('r.txt', 'two')" : "printf two > r.txt");
  assert.equal((await undoRequest(where.chatId, { runIds: [] , action: "preview" })).status, 400);
  assert.equal((await undoRequest(where.chatId, { runIds: ["../x"], action: "preview" })).status, 400);
  assert.equal((await undoRequest("missing-chat", { runIds: [where.runId], action: "preview" })).status, 404);
  const preview = await undoRequest(where.chatId, { runIds: [where.runId], action: "preview" });
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).data.files.map((item: { status: string }) => item.status), ["ready"]);
  assert.equal(readFileSync(path.join(where.root, "r.txt"), "utf8"), "two");
  const applied = await undoRequest(where.chatId, { runIds: [where.runId], action: "undo" });
  assert.deepEqual((await applied.json()).data.files.map((item: { status: string }) => item.status), ["undone"]);
  assert.equal(readFileSync(path.join(where.root, "r.txt"), "utf8"), "one");
  // Another conversation's runs are not this conversation's to undo.
  const other = await db.chat.create({ data: { title: "Other" } });
  assert.deepEqual((await (await undoRequest(other.id, { runIds: [where.runId], action: "undo" })).json()).data.files, []);
});

test("files can be undone one by one, and the two halves of a rename are paired", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "a.txt"), "a1");
  writeFileSync(path.join(where.root, "b.txt"), "b1");
  writeFileSync(path.join(where.root, "old-name.txt"), "moved content");
  await command(where, win
    ? "[IO.File]::WriteAllText('a.txt', 'a2'); [IO.File]::WriteAllText('b.txt', 'b2'); Move-Item -LiteralPath 'old-name.txt' -Destination 'new-name.txt'"
    : "printf a2 > a.txt; printf b2 > b.txt; mv old-name.txt new-name.txt");
  const preview = await previewUndo(where.chatId, [where.runId]);
  assert.equal(preview.find(item => item.path === "old-name.txt")?.pairedWith, "new-name.txt");
  assert.equal(preview.find(item => item.path === "new-name.txt")?.pairedWith, "old-name.txt");
  assert.equal(preview.find(item => item.path === "a.txt")?.pairedWith, undefined);
  // Only a.txt.
  const only = await applyUndo(where.chatId, [where.runId], [{ grantId: where.grantId, path: "a.txt" }]);
  assert.deepEqual(only.map(item => [item.path, item.status]), [["a.txt", "undone"]]);
  assert.equal(readFileSync(path.join(where.root, "a.txt"), "utf8"), "a1");
  assert.equal(readFileSync(path.join(where.root, "b.txt"), "utf8"), "b2", "a file not chosen is left as it is");
  // The rename, both halves together.
  await applyUndo(where.chatId, [where.runId], [{ grantId: where.grantId, path: "old-name.txt" }, { grantId: where.grantId, path: "new-name.txt" }]);
  assert.equal(readFileSync(path.join(where.root, "old-name.txt"), "utf8"), "moved content");
  assert.equal(existsSync(path.join(where.root, "new-name.txt")), false);
  assert.deepEqual((await previewUndo(where.chatId, [where.runId])).map(item => item.path), ["b.txt"]);
  // The route takes the same selection.
  assert.equal((await undoRequest(where.chatId, { runIds: [where.runId], action: "preview", files: [] })).status, 400);
  const routed = await undoRequest(where.chatId, { runIds: [where.runId], action: "undo", files: [{ grantId: where.grantId, path: "b.txt" }] });
  assert.deepEqual((await routed.json()).data.files.map((item: { path: string; status: string }) => [item.path, item.status]), [["b.txt", "undone"]]);
});

const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=RiA test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: root, stdio: "pipe" });

test("in a git repository, committed unchanged files are restored from git without a copy, and large ignored files are not copied", { skip: !hasGit && "git is not installed" }, async () => {
  const where = await workspace();
  git(where.root, "init", "-q");
  git(where.root, "config", "core.autocrlf", "false");
  writeFileSync(path.join(where.root, ".gitignore"), "build/\n.env\n");
  writeFileSync(path.join(where.root, "tracked.ts"), "export const committed = true;\n");
  git(where.root, "add", ".");
  git(where.root, "commit", "-q", "-m", "start");
  writeFileSync(path.join(where.root, ".env"), "SECRET_FOR_TEST=1\n");
  mkdirSync(path.join(where.root, "build"));
  writeFileSync(path.join(where.root, "build", "bundle.js"), Buffer.alloc(2 * 1024 * 1024, 120));
  writeFileSync(path.join(where.root, "untracked.txt"), "not in git");
  const snapshot = await captureFileSnapshot(where.root, Infinity, { keep: true });
  const tracked = snapshot.files.get("tracked.ts")!;
  assert.equal(tracked.kept, true);
  assert.match(tracked.gitOid ?? "", /^[a-f0-9]{40}$/);
  assert.equal(await hasBlob(tracked.hash!), false, "git holds it, so no copy was made");
  assert.equal(snapshot.files.get(".env")?.kept, true, "a small ignored file is still copied");
  assert.deepEqual([snapshot.files.get("build/bundle.js")?.kept, snapshot.files.get("build/bundle.js")?.skipped], [false, "ignored"]);
  assert.equal(snapshot.files.get("untracked.txt")?.kept, true);

  await command(where, win
    ? "[IO.File]::WriteAllText('tracked.ts', 'broken'); Remove-Item -LiteralPath 'untracked.txt'; [IO.File]::WriteAllText('build/bundle.js', 'rebuilt')"
    : "printf broken > tracked.ts; rm untracked.txt; printf rebuilt > build/bundle.js");
  const rows = await db.fileCheckpoint.findMany({ where: { chatId: where.chatId } });
  const row = (file: string) => rows.find(item => item.path === file)!;
  assert.ok(row("tracked.ts").beforeGitOid);
  assert.deepEqual([row("build/bundle.js").restorable, row("build/bundle.js").reason], [false, "ignored"]);
  const results = await applyUndo(where.chatId, [where.runId]);
  assert.deepEqual(Object.fromEntries(results.map(item => [item.path, item.status])), { "tracked.ts": "undone", "untracked.txt": "undone", "build/bundle.js": "not-kept" });
  assert.equal(readFileSync(path.join(where.root, "tracked.ts"), "utf8"), "export const committed = true;\n");
  assert.equal(readFileSync(path.join(where.root, "untracked.txt"), "utf8"), "not in git");
});

test("content is compressed when that pays, and a full store refuses new copies once instead of re-reading them on every walk", async () => {
  const text = Buffer.from("const repeated = 1;\n".repeat(5000));
  const hash = await putBlob(text);
  const shard = path.join(checkpointRoot(), "blobs", hash!.slice(0, 2));
  assert.ok(readdirSync(shard).includes(`${hash}.gz`), "text is stored compressed");
  assert.deepEqual(await readBlob(hash!), text);

  const where = await workspace();
  writeFileSync(path.join(where.root, "big-enough.txt"), `fresh ${Date.now()} ${"x".repeat(1000)}`);
  await saveStoreLimit(0);
  try {
    const first = await captureFileSnapshot(where.root, Infinity, { keep: true });
    const version = first.files.get("big-enough.txt")!;
    assert.deepEqual([version.kept, version.skipped], [false, "store-full"]);
    const second = await captureFileSnapshot(where.root, Infinity, { keep: true });
    assert.equal(second.files.get("big-enough.txt"), version, "a refused file is not read again while the store stays full");
    // A changed file is recorded as not undoable, with the reason.
    await command(where, win ? "[IO.File]::WriteAllText('big-enough.txt', 'changed')" : "printf changed > big-enough.txt");
    const row = await db.fileCheckpoint.findFirstOrThrow({ where: { chatId: where.chatId } });
    assert.deepEqual([row.restorable, row.reason], [false, "store-full"]);
  } finally { await saveStoreLimit(2048); }
  // Room again: the next walk copies it.
  const later = await captureFileSnapshot(where.root, Infinity, { keep: true });
  assert.equal(later.files.get("big-enough.txt")?.kept, true);
});

test("the undo storage limit is read and changed through its route, only to one of the offered sizes", async () => {
  const request = (method: string, body?: unknown) => new NextRequest("http://localhost/api/checkpoint-preferences", {
    method, headers: { host: "localhost", cookie: localAccessCookie(), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = await (await preferencesRoute.GET(request("GET"))).json();
  assert.equal(read.data.limitMb, 2048);
  assert.equal(typeof read.data.usedBytes, "number");
  assert.equal((await preferencesRoute.PUT(request("PUT", { limitMb: 3000 }))).status, 400);
  const saved = await (await preferencesRoute.PUT(request("PUT", { limitMb: 5120 }))).json();
  assert.equal(saved.data.limitMb, 5120);
  assert.equal((await db.checkpointPreference.findUniqueOrThrow({ where: { id: "local" } })).limitMb, 5120);
  await preferencesRoute.PUT(request("PUT", { limitMb: 2048 }));
});

test("an undo can be redone while the file is as the undo left it, and the card's states come from the records alone", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "page.ts"), "v1");
  writeFileSync(path.join(where.root, "gone.txt"), "deleted by the turn");
  writeFileSync(path.join(where.root, "kept.txt"), "k1");
  await command(where, win
    ? "[IO.File]::WriteAllText('page.ts', 'v2'); Remove-Item -LiteralPath 'gone.txt'; [IO.File]::WriteAllText('made.txt', 'new'); [IO.File]::WriteAllText('kept.txt', 'k2')"
    : "printf v2 > page.ts; rm gone.txt; printf new > made.txt; printf k2 > kept.txt");
  const before = await undoStates(where.chatId, [where.runId]);
  assert.deepEqual(before.map(item => [item.path, item.status, !!item.undone]).sort(), [
    ["gone.txt", "ready", false], ["kept.txt", "ready", false], ["made.txt", "ready", false], ["page.ts", "ready", false],
  ]);
  const files = ["page.ts", "gone.txt", "made.txt"].map(file => ({ grantId: where.grantId, path: file }));
  await applyUndo(where.chatId, [where.runId], files);
  assert.equal(readFileSync(path.join(where.root, "page.ts"), "utf8"), "v1");
  assert.equal(existsSync(path.join(where.root, "made.txt")), false);
  const after = Object.fromEntries((await undoStates(where.chatId, [where.runId])).map(item => [item.path, [item.status, item.undone ?? false, item.redoable ?? false]]));
  assert.deepEqual(after, { "page.ts": ["undone", true, true], "gone.txt": ["undone", true, true], "made.txt": ["undone", true, true], "kept.txt": ["ready", false, false] });
  assert.deepEqual((await previewRedo(where.chatId, [where.runId])).map(item => item.status), ["ready", "ready", "ready"]);

  const redone = await applyRedo(where.chatId, [where.runId], files);
  assert.ok(redone.every(item => item.status === "redone"), JSON.stringify(redone));
  assert.equal(readFileSync(path.join(where.root, "page.ts"), "utf8"), "v2");
  assert.equal(existsSync(path.join(where.root, "gone.txt")), false);
  assert.equal(readFileSync(path.join(where.root, "made.txt"), "utf8"), "new");
  assert.ok((await undoStates(where.chatId, [where.runId])).every(item => item.status === "ready" && !item.undone));
  assert.match(takeUndoContext(where.chatId), /redone/);

  // Undo again, then the user edits the file: redo leaves it alone.
  await applyUndo(where.chatId, [where.runId], [files[0]]);
  writeFileSync(path.join(where.root, "page.ts"), "edited after the undo");
  assert.deepEqual((await applyRedo(where.chatId, [where.runId], [files[0]])).map(item => [item.status, item.undone]), [["changed", true]]);
  assert.equal(readFileSync(path.join(where.root, "page.ts"), "utf8"), "edited after the undo");
  // The route reads states without the stricter limit and accepts the new actions only.
  const status = await undoRequest(where.chatId, { runIds: [where.runId], action: "status" });
  assert.equal(status.status, 200);
  assert.equal((await undoRequest(where.chatId, { runIds: [where.runId], action: "explode" })).status, 400);
  assert.equal((await undoRequest(where.chatId, { runIds: [where.runId], apply: true })).status, 400);
});

type WriteLocks = Map<string, Promise<unknown>>;
/**
 * Holds RiA's write lock on a file while `start` runs until it waits for that
 * lock (it has checked the file and is about to change it), then runs
 * `meanwhile` (another program writing the file) and lets it go on.
 */
async function whileWaitingToWrite<T>(absolute: string, start: () => Promise<T>, meanwhile: () => void): Promise<T> {
  let release!: () => void;
  const held = withFileWriteLock(absolute, () => new Promise<void>(resolve => { release = resolve; }));
  const locks = (globalThis as { __riaFileWriteLocks?: WriteLocks }).__riaFileWriteLocks!;
  const key = win ? absolute.toLowerCase() : absolute;
  const ours = locks.get(key);
  const pending = start();
  for (let turn = 0; locks.get(key) === ours; turn++) {
    if (turn > 100_000) throw new Error("the change never reached the file");
    await new Promise(resolve => setImmediate(resolve));
  }
  meanwhile();
  release();
  await held;
  return pending;
}
const leftovers = (root: string) => readdirSync(root, { recursive: true }).map(String).filter(name => name.includes(".ria-undo-") || name.includes(".ria-edit-"));

test("undo checks each file again as it changes it: a file rewritten or recreated meanwhile is kept, with its records", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "notes.txt"), "before");
  writeFileSync(path.join(where.root, "old.txt"), "deleted by the turn");
  await command(where, win
    ? "[IO.File]::WriteAllText('notes.txt', 'after'); Remove-Item -LiteralPath 'old.txt'"
    : "printf after > notes.txt; rm old.txt");
  const notes = path.join(where.root, "notes.txt"), old = path.join(where.root, "old.txt");
  const only = (file: string) => [{ grantId: where.grantId, path: file }];

  const rewritten = await whileWaitingToWrite(notes, () => applyUndo(where.chatId, [where.runId], only("notes.txt")), () => writeFileSync(notes, "the user's version"));
  assert.deepEqual(rewritten.map(item => item.status), ["changed"]);
  assert.equal(readFileSync(notes, "utf8"), "the user's version");
  const recreated = await whileWaitingToWrite(old, () => applyUndo(where.chatId, [where.runId], only("old.txt")), () => writeFileSync(old, "a new file with the same name"));
  assert.deepEqual(recreated.map(item => item.status), ["changed"]);
  assert.equal(readFileSync(old, "utf8"), "a new file with the same name");
  assert.ok((await db.fileCheckpoint.findMany({ where: { chatId: where.chatId } })).every(row => row.undoneAt === null), "nothing is marked undone");
  assert.deepEqual(leftovers(where.root), []);

  // Once the files are as the turn left them again, the same records undo them.
  writeFileSync(notes, "after");
  rmSync(old);
  assert.ok((await applyUndo(where.chatId, [where.runId])).every(item => item.status === "undone"));
  assert.equal(readFileSync(notes, "utf8"), "before");
  assert.equal(readFileSync(old, "utf8"), "deleted by the turn");
  assert.deepEqual(leftovers(where.root), []);
});

test("redo checks the file again too, never writes over a file created meanwhile, and leaves exactly what the turn left", async () => {
  const where = await workspace();
  writeFileSync(path.join(where.root, "page.ts"), "line one\r\nline two\n");
  await command(where, win
    ? "[IO.File]::WriteAllText('page.ts', \"changed`r`nby the turn`n\"); [IO.File]::WriteAllText('made.txt', 'created by the turn')"
    : "printf 'changed\\r\\nby the turn\\n' > page.ts; printf 'created by the turn' > made.txt");
  const rows = await db.fileCheckpoint.findMany({ where: { chatId: where.chatId } });
  assert.ok((await applyUndo(where.chatId, [where.runId])).every(item => item.status === "undone"));
  const made = path.join(where.root, "made.txt");
  const redoMade = await whileWaitingToWrite(made, () => applyRedo(where.chatId, [where.runId], [{ grantId: where.grantId, path: "made.txt" }]), () => writeFileSync(made, "someone else's file"));
  assert.deepEqual(redoMade.map(item => [item.status, item.undone]), [["changed", true]]);
  assert.equal(readFileSync(made, "utf8"), "someone else's file");

  assert.deepEqual((await applyRedo(where.chatId, [where.runId], [{ grantId: where.grantId, path: "page.ts" }])).map(item => item.status), ["redone"]);
  assert.equal(sha256(readFileSync(path.join(where.root, "page.ts"))), rows.find(row => row.path === "page.ts")!.afterHash, "the same bytes the turn left");
  assert.deepEqual(leftovers(where.root), []);
});

test("RiA's own edit and an undo of the same file take turns, and the file and its records agree whichever goes first", async () => {
  const where = await workspace();
  const file = path.join(where.root, "math.ts");
  writeFileSync(file, "export const value = 1;\n");
  const first = await bindProjectEdit({ grantId: where.grantId, path: "math.ts", expectedHash: contentHash(readFileSync(file)), edits: [{ oldText: "1", newText: "2" }] });
  await applyProjectEdit(first, undefined, { chatId: where.chatId, runId: where.runId });
  const second = await bindProjectEdit({ grantId: where.grantId, path: "math.ts", expectedHash: contentHash(readFileSync(file)), edits: [{ oldText: "2", newText: "3" }] });
  const [undone, edited] = await Promise.allSettled([applyUndo(where.chatId, [where.runId]), applyProjectEdit(second)]);
  assert.equal(undone.status, "fulfilled");
  const status = undone.status === "fulfilled" ? undone.value[0]?.status : null;
  const marked = (await db.fileCheckpoint.findFirstOrThrow({ where: { chatId: where.chatId } })).undoneAt !== null;
  if (status === "undone") {
    assert.equal(edited.status, "rejected", "the edit was planned against content the undo replaced");
    assert.equal(readFileSync(file, "utf8"), "export const value = 1;\n");
    assert.equal(marked, true);
  } else {
    assert.equal(status, "changed");
    assert.equal(edited.status, "fulfilled");
    assert.equal(readFileSync(file, "utf8"), "export const value = 3;\n");
    assert.equal(marked, false);
  }
});

test("a file created by something else after the file tool planned a new file is not written over", async () => {
  const where = await workspace();
  const target = path.join(where.root, "fresh.md");
  const planned = await bindProjectEdit({ grantId: where.grantId, path: "fresh.md", content: "# From the model\n" });
  await assert.rejects(whileWaitingToWrite(target, () => applyProjectEdit(planned), () => writeFileSync(target, "the user's file")));
  assert.equal(readFileSync(target, "utf8"), "the user's file");
  assert.deepEqual(leftovers(where.root), []);
});

test("an undo that cannot be recorded is taken back, so the file and its records still agree", async () => {
  const where = await workspace();
  const file = path.join(where.root, "notes.txt");
  writeFileSync(file, "before");
  await command(where, win ? "[IO.File]::WriteAllText('notes.txt', 'after')" : "printf after > notes.txt");
  // The database refuses the record of the undo.
  await db.$executeRawUnsafe(`CREATE TRIGGER "test_refuse_undo" BEFORE UPDATE OF "undoneAt" ON "file_checkpoints" BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`);
  let results;
  try { results = await applyUndo(where.chatId, [where.runId]); } finally { await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_refuse_undo"`); }
  assert.deepEqual(results.map(item => item.status), ["failed"]);
  assert.equal(readFileSync(file, "utf8"), "after", "the file is back as the turn left it");
  assert.equal((await db.fileCheckpoint.findFirstOrThrow({ where: { chatId: where.chatId } })).undoneAt, null);
  assert.deepEqual(leftovers(where.root), []);
  assert.deepEqual((await applyUndo(where.chatId, [where.runId])).map(item => item.status), ["undone"]);
  assert.equal(readFileSync(file, "utf8"), "before");
});

test("the commit step changes a file only while it is as expected, and can take its change back", async () => {
  const where = await workspace();
  const file = path.join(where.root, "a.txt");
  const content = (text: string) => ({ hash: sha256(Buffer.from(text)), write: async (temporary: string) => { writeFileSync(temporary, text, { flag: "wx" }); return true; } });
  writeFileSync(file, "mine");
  assert.equal((await commitFile(file, sha256(Buffer.from("expected")), content("new"))).status, "changed");
  assert.equal((await commitFile(file, null, content("new"))).status, "changed", "a file that should not exist is never written over");
  assert.equal((await commitFile(file, sha256(Buffer.from("mine")), { hash: "0".repeat(64), write: async () => false })).status, "missing-content");
  assert.equal(readFileSync(file, "utf8"), "mine");
  const done = await commitFile(file, sha256(Buffer.from("mine")), content("new"));
  assert.equal(done.status, "done");
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.equal(done.status === "done" && await done.revert(), true);
  assert.equal(readFileSync(file, "utf8"), "mine");
  const removed = await commitFile(file, sha256(Buffer.from("mine")), null);
  assert.equal(removed.status, "done");
  if (removed.status === "done") await removed.finish();
  assert.equal(existsSync(file), false);
  assert.deepEqual(leftovers(where.root), []);
});

test("the git blob writer settles only once git and the file are done, and leaves nothing of its own behind", { skip: !hasGit && "git is not installed" }, async () => {
  const where = await workspace();
  git(where.root, "init", "-q");
  writeFileSync(path.join(where.root, "tracked.txt"), "from git\n");
  git(where.root, "add", ".");
  git(where.root, "commit", "-q", "-m", "start");
  const oid = execFileSync("git", ["rev-parse", "HEAD:tracked.txt"], { cwd: where.root, encoding: "utf8" }).trim();
  const expected = sha256(Buffer.from("from git\n"));
  const target = (name: string) => path.join(where.root, name);

  assert.equal(await writeGitBlob(where.root, oid, expected, target("restored.tmp")), true);
  assert.equal(readFileSync(target("restored.tmp"), "utf8"), "from git\n");
  // The file cannot be written: git is stopped and nothing is created.
  assert.equal(await writeGitBlob(where.root, oid, expected, path.join(where.root, "missing", "x.tmp")), false);
  assert.equal(existsSync(path.join(where.root, "missing")), false);
  // A file already at that name is not this writer's to remove.
  writeFileSync(target("taken.tmp"), "already here");
  assert.equal(await writeGitBlob(where.root, oid, expected, target("taken.tmp")), false);
  assert.equal(readFileSync(target("taken.tmp"), "utf8"), "already here");
  // Git cannot start, exits early (no such object) or gives other content.
  const path_ = process.env.PATH;
  process.env.PATH = "";
  try { assert.equal(await writeGitBlob(where.root, oid, expected, target("no-git.tmp")), false); } finally { process.env.PATH = path_; }
  assert.equal(await writeGitBlob(where.root, "0".repeat(40), expected, target("early.tmp")), false);
  assert.equal(await writeGitBlob(where.root, oid, sha256(Buffer.from("other")), target("differs.tmp")), false);
  for (const name of ["no-git.tmp", "early.tmp", "differs.tmp"]) assert.equal(existsSync(target(name)), false, name);
  // Nothing still holds the folder afterwards: it can be removed at once.
  const inner = path.join(where.root, "inner");
  mkdirSync(inner);
  assert.equal(await writeGitBlob(where.root, "0".repeat(40), expected, path.join(inner, "x.tmp")), false);
  rmSync(inner, { recursive: true });
});
