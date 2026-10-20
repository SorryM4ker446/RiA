import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants } = await import("@/lib/local-files/grants");
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
const { bindTerminalApproval, runTerminalCommand, getTerminalSession } = await import("@/lib/terminal/runtime");
const { captureFileSnapshot, compareFileSnapshots } = await import("@/lib/terminal/file-changes");
const { collectEditedFiles } = await import("@/lib/terminal/file-change-summary");
const resolveRoute = await import("@/app/api/terminal/files/resolve/route");
const roots: string[] = [];
const win = process.platform === "win32";

async function folder() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ria-file-changes-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt);
  return (await listGrants()).find(value => value.id === grant.id)!;
}
const run = async (grantId: string, command: string, signal?: AbortSignal) => runTerminalCommand(await bindTerminalApproval({ grantId, command, timeoutSeconds: 20 }), signal);
after(async () => {
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== await realpath(tmpdir()) || !path.basename(root).startsWith("ria-file-changes-")) throw new Error("Unexpected file-change test directory");
    await rm(root, { recursive: true, force: true });
  }
  cleanup();
});

test("terminal results report actual created, modified and deleted files, including same-size edits, without reporting reads", async () => {
  const grant = await folder();
  await writeFile(path.join(grant.realPath, "source.ts"), "export const value = 1;\n");
  await writeFile(path.join(grant.realPath, "obsolete.txt"), "old\n");
  const command = win ? "[IO.File]::WriteAllText('source.ts', \"export const value = 2;`n\"); [IO.File]::WriteAllText('新增.md', \"# Done`n\"); Remove-Item -LiteralPath 'obsolete.txt'"
    : "printf 'export const value = 2;\\n' > source.ts; printf '# Done\\n' > 新增.md; rm obsolete.txt";
  const result = await run(grant.id, command);
  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.fileChanges?.complete, true);
  assert.deepEqual(Object.fromEntries(result.fileChanges!.files.map(file => [file.path, file.kind])), { "source.ts": "modified", "obsolete.txt": "deleted", "新增.md": "created" });
  assert.deepEqual(result.fileChanges!.files.find(file => file.path === "source.ts")!.after, { bytes: 24, lines: 1 });
  assert.equal(result.fileChanges!.files.find(file => file.path === "obsolete.txt")!.after, null);
  assert.equal((await run(grant.id, win ? "Get-Content -LiteralPath 'source.ts'" : "cat source.ts")).fileChanges!.files.length, 0);
  assert.equal((await readFile(path.join(grant.realPath, "新增.md"), "utf8")), "# Done\n");
});

test("failed and stopped commands retain the file changes actually written before exit", async () => {
  const grant = await folder();
  const failed = await run(grant.id, win ? "[IO.File]::WriteAllText('partial.txt','saved'); exit 7" : "printf saved > partial.txt; exit 7");
  assert.equal(failed.status, "failed");
  assert.equal(failed.fileChanges?.files[0].path, "partial.txt");
  const input = await bindTerminalApproval({ grantId: grant.id, command: win ? "[IO.File]::WriteAllText('stopped.txt','saved'); [Console]::WriteLine('ready'); Start-Sleep -Seconds 30" : "printf saved > stopped.txt; printf ready; sleep 30", timeoutSeconds: 20 });
  const controller = new AbortController();
  const pending = runTerminalCommand(input, controller.signal);
  try {
    const deadline = Date.now() + 10_000;
    while (!getTerminalSession(input.binding.sessionId).stdout.includes("ready")) {
      if (Date.now() > deadline) assert.fail("Command never became ready");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort();
    const stopped = await pending;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.fileChanges?.files[0].path, "stopped.txt");
  } finally { controller.abort(); await pending.catch(() => {}); }
});

test("snapshots skip dependencies and junctions, and partial observations do not invent additions or deletions", async () => {
  const grant = await folder();
  const outside = await folder();
  await mkdir(path.join(grant.realPath, "node_modules"));
  await writeFile(path.join(grant.realPath, "node_modules", "ignored.ts"), "dependency");
  await writeFile(path.join(outside.realPath, "outside.txt"), "outside");
  await symlink(outside.realPath, path.join(grant.realPath, "linked"), win ? "junction" : "dir");
  const before = await captureFileSnapshot(grant.realPath);
  assert.deepEqual([...before.files.keys()], []);
  await writeFile(path.join(grant.realPath, "inside.ts"), "const value = 1;\n");
  const after = await captureFileSnapshot(grant.realPath);
  assert.deepEqual(compareFileSnapshots(before, after).files.map(file => file.path), ["inside.ts"]);
  assert.deepEqual(compareFileSnapshots({ ...before, complete: false }, after), { files: [], complete: false });
  assert.deepEqual(compareFileSnapshots(after, { ...before, complete: false }), { files: [], complete: false });
});

test("opening a reported file rechecks authentication, containment, current permission and existence without format restrictions", async () => {
  const grant = await folder();
  const outside = await folder();
  await writeFile(path.join(grant.realPath, "file.tsx"), "export default function Page() {}\n");
  await writeFile(path.join(outside.realPath, "outside.txt"), "outside");
  await symlink(outside.realPath, path.join(grant.realPath, "linked"), win ? "junction" : "dir");
  const request = (name: string, cookie = localAccessCookie()) => new NextRequest("http://localhost/api/terminal/files/resolve", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ grantId: grant.id, path: name }) });
  assert.equal((await resolveRoute.POST(request("file.tsx", ""))).status, 401);
  const response = await resolveRoute.POST(request("file.tsx"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.absolutePath, await realpath(path.join(grant.realPath, "file.tsx")));
  for (const name of ["../outside.txt", "C:/outside.txt", "file.tsx:stream", "file\0.tsx", "/absolute.txt"]) assert.equal((await resolveRoute.POST(request(name))).status, 400);
  assert.equal((await resolveRoute.POST(request("linked/outside.txt"))).status, 403);
  assert.equal((await resolveRoute.POST(request("deleted.ts"))).status, 404);
  await setTerminalPermission(grant.id, false, grant.updatedAt);
  assert.equal((await resolveRoute.POST(request("file.tsx"))).status, 403);
});

test("a reply merges repeated edits and drops files created then deleted within that reply", () => {
  const part = (files: unknown[], complete = true) => ({ type: "tool-runTerminalCommand", state: "output-available", output: { grantId: "folder", cwd: "fixture", fileChanges: { files, complete } } });
  const first = { path: "created.ts", kind: "created", before: null, after: { bytes: 12, lines: 1 } };
  const second = { ...first, kind: "modified", before: first.after, after: { bytes: 24, lines: 2 } };
  const result = collectEditedFiles([part([first]), part([second])]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].kind, "created");
  assert.equal(result.files[0].after?.lines, 2);
  assert.deepEqual(collectEditedFiles([part([first]), part([{ ...second, kind: "deleted", after: null }])]).files, []);
  assert.equal(collectEditedFiles([part([], false)]).complete, false);
  assert.deepEqual(collectEditedFiles([{ type: "tool-runTerminalCommand", state: "output-available", output: {} }]), { files: [], complete: true });
});
