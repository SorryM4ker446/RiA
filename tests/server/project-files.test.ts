import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { asSchema, type UIMessage } from "ai";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
const { readProjectFile, bindProjectEdit, applyProjectEdit, editProjectFileInputSchema } = await import("@/lib/project-files/service");
const { applyEdits, unifiedDiff } = await import("@/lib/project-files/edits");
const { contentHash } = await import("@/lib/project-files/text");
const { createChatToolSet } = await import("@/tools/catalog");
const { collectEditedFiles } = await import("@/lib/terminal/file-change-summary");
const { historicalToolText } = await import("@/lib/chat/tool-history");
const { claimToolApproval } = await import("@/lib/chat/store");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");

const roots: string[] = [];
async function folder(mode: "approval" | "full-access" | null = "approval") {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-project-files-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  if (mode) await setTerminalPermission(grant.id, true, grant.updatedAt, mode);
  return { root, grant: (await listGrants()).find(row => row.id === grant.id)! };
}
const hashOf = (file: string) => contentHash(readFileSync(file));
/** The tool flow: bind when the model proposes, then execute what was bound. */
async function edit(input: Record<string, unknown>) {
  const bound = await bindProjectEdit({ ...input });
  return { bound, run: () => applyProjectEdit(editProjectFileInputSchema.parse(bound)) };
}

beforeEach(() => { process.env.APP_RUNTIME = "test"; });
after(async () => {
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== realpathSync.native(tmpdir()) || !path.basename(root).startsWith("ria-project-files-")) throw new Error("Unexpected test directory");
    try { chmodSync(path.join(root, "locked.txt"), 0o666); } catch { /* not created */ }
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});

test("reads return numbered line ranges with the hash, line endings and BOM of the file", async () => {
  const { root, grant } = await folder();
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  writeFileSync(path.join(root, "notes.ts"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join("\r\n") + "\r\n")]));
  const page = await readProjectFile({ grantId: grant.id, path: "notes.ts", startLine: 3, lineCount: 4 });
  assert.deepEqual(page.lines, [3, 4, 5, 6].map(line => ({ line, text: `line ${line}` })));
  assert.equal(page.totalLines, 10); assert.equal(page.nextLine, 7);
  assert.equal(page.eol, "crlf"); assert.equal(page.bom, true);
  assert.equal(page.hash, hashOf(path.join(root, "notes.ts")));
  const end = await readProjectFile({ grantId: grant.id, path: "notes.ts", startLine: 9, lineCount: 400 });
  assert.equal(end.nextLine, null); assert.equal(end.lines.length, 2);
});

test("project paths allow configuration dot-files but refuse internals, credentials, escapes and non-text files", async () => {
  const { root, grant } = await folder();
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  writeFileSync(path.join(root, ".env.example"), "TOKEN=\n");
  assert.equal((await readProjectFile({ grantId: grant.id, path: ".github/workflows/ci.yml", startLine: 1, lineCount: 10 })).lines[0].text, "name: ci");
  assert.equal((await readProjectFile({ grantId: grant.id, path: ".env.example", startLine: 1, lineCount: 10 })).lines[0].text, "TOKEN=");
  mkdirSync(path.join(root, ".git"));
  for (const [name, content] of [[".env", "SECRET=1\n"], [".env.local", "SECRET=1\n"], [".git/config", "[core]\n"], ["id_rsa", "key\n"], ["server.pem", "key\n"], [".npmrc", "//token\n"]] as const) {
    writeFileSync(path.join(root, name), content);
    await assert.rejects(readProjectFile({ grantId: grant.id, path: name, startLine: 1, lineCount: 10 }), { reason: "sensitive" });
  }
  await assert.rejects(readProjectFile({ grantId: grant.id, path: "../outside.txt", startLine: 1, lineCount: 10 }), { reason: "traversal" });
  writeFileSync(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await assert.rejects(readProjectFile({ grantId: grant.id, path: "image.bin", startLine: 1, lineCount: 10 }), { reason: "not-text" });
  writeFileSync(path.join(root, "wide.txt"), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  await assert.rejects(readProjectFile({ grantId: grant.id, path: "wide.txt", startLine: 1, lineCount: 10 }), { reason: "not-text" });
  await assert.rejects(edit({ grantId: grant.id, path: ".env", content: "X=1\n" }), { reason: "sensitive" });
});

test("file tools require the folder's terminal permission", async () => {
  const { root, grant } = await folder(null);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  await assert.rejects(readProjectFile({ grantId: grant.id, path: "a.txt", startLine: 1, lineCount: 10 }), { code: "FORBIDDEN" });
  await assert.rejects(edit({ grantId: grant.id, path: "a.txt", content: "b\n" }), { code: "FORBIDDEN" });
});

test("exact edits keep CRLF and BOM, report a correct diff and apply all edits together", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "app.ts");
  const source = ["import a from 'a';", "", "export function add(x, y) {", "  return x - y;", "}", "", ...Array.from({ length: 12 }, (_, i) => `// filler ${i}`), "export const name = 'old';", ""].join("\r\n");
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]));
  const { bound, run } = await edit({ grantId: grant.id, path: "app.ts", expectedHash: hashOf(file), edits: [
    { oldText: "  return x - y;", newText: "  return x + y;" },
    { oldText: "export const name = 'old';", newText: "export const name = 'new';\nexport const version = 2;" },
  ] });
  assert.equal(bound.binding.added, 3); assert.equal(bound.binding.removed, 2);
  assert.match(bound.binding.diff, /^--- a\/app\.ts\n\+\+\+ b\/app\.ts\n@@ -1,7 \+1,7 @@/);
  assert.match(bound.binding.diff, /\n-  return x - y;\n\+  return x \+ y;\n/);
  assert.match(bound.binding.diff, /@@ -16,4 \+16,5 @@/);
  assert.equal(readFileSync(file).subarray(3).toString(), source, "nothing is written before execution");
  const result = await run();
  const written = readFileSync(file);
  assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = written.subarray(3).toString();
  assert.ok(text.includes("  return x + y;\r\nexport") === false && text.includes("  return x + y;\r\n}"));
  assert.ok(text.includes("export const name = 'new';\r\nexport const version = 2;\r\n"));
  assert.equal(text.split("\n").length, text.split("\r\n").length, "every line ending stays CRLF");
  assert.equal(result.hash, hashOf(file)); assert.equal(result.created, false);
  assert.deepEqual(result.fileChanges.files.map(change => change.kind), ["modified"]);
});

test("ambiguous, missing and overlapping edits are refused with what to do, and nothing is written", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "list.txt");
  writeFileSync(file, "alpha\nbeta\nalpha\n    gamma value\n");
  const hash = hashOf(file);
  await assert.rejects(edit({ grantId: grant.id, path: "list.txt", expectedHash: hash, edits: [{ oldText: "alpha", newText: "A" }] }), /matches 2 places \(lines 1, 3\)/);
  await assert.rejects(edit({ grantId: grant.id, path: "list.txt", expectedHash: hash, edits: [{ oldText: "gamma value\n  extra", newText: "x" }] }), /Lines containing its first line: 4/);
  await assert.rejects(edit({ grantId: grant.id, path: "list.txt", expectedHash: hash, edits: [{ oldText: "beta", newText: "B" }, { oldText: "eta\nal", newText: "x" }] }), /overlap at line 2/);
  await assert.rejects(edit({ grantId: grant.id, path: "list.txt", expectedHash: hash, edits: [{ oldText: "beta", newText: "B" }, { oldText: "missing", newText: "x" }] }), /edits\[1\]\.oldText was not found/);
  await assert.rejects(edit({ grantId: grant.id, path: "list.txt", expectedHash: hash, edits: [{ oldText: "beta", newText: "beta" }] }), /no change/);
  assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\nalpha\n    gamma value\n");
  const all = await edit({ grantId: grant.id, path: "list.txt", expectedHash: hash, edits: [{ oldText: "alpha", newText: "A", replaceAll: true }] });
  await all.run();
  assert.equal(readFileSync(file, "utf8"), "A\nbeta\nA\n    gamma value\n");
});

test("creating, rewriting and the expected hash protect against writing over unseen content", async () => {
  const { root, grant } = await folder();
  const created = await edit({ grantId: grant.id, path: "src/new.ts", content: "export {};\n" }).catch(error => error);
  assert.equal(created.reason, "not-found", "the parent folder must exist");
  mkdirSync(path.join(root, "src"));
  const create = await edit({ grantId: grant.id, path: "src/new.ts", content: "export {};\r\n" });
  assert.equal(create.bound.binding.created, true); assert.match(create.bound.binding.diff, /^--- \/dev\/null\n\+\+\+ b\/src\/new\.ts\n@@ -0,0 \+1,1 @@\n\+export \{\};/);
  const createdResult = await create.run();
  assert.equal(readFileSync(path.join(root, "src", "new.ts"), "utf8"), "export {};\r\n", "a new file is written exactly as given");
  assert.equal(createdResult.fileChanges.files[0].kind, "created");
  await assert.rejects(edit({ grantId: grant.id, path: "src/new.ts", content: "other\n" }), /already exists/);
  await assert.rejects(edit({ grantId: grant.id, path: "src/new.ts", expectedHash: "0000000000000000", content: "other\n" }), /changed since it was read \(current hash/);
  await assert.rejects(edit({ grantId: grant.id, path: "src/absent.ts", expectedHash: "0000000000000000", content: "x\n" }), /no longer exists/);
  await assert.rejects(edit({ grantId: grant.id, path: "src/absent.ts", edits: [{ oldText: "a", newText: "b" }] }), /does not exist/);
  const rewrite = await edit({ grantId: grant.id, path: "src/new.ts", expectedHash: hashOf(path.join(root, "src", "new.ts")), content: "export const value = 1;\n" });
  await rewrite.run();
  assert.equal(readFileSync(path.join(root, "src", "new.ts"), "utf8"), "export const value = 1;\r\n", "a rewrite keeps the file's line endings");
  assert.throws(() => editProjectFileInputSchema.parse({ grantId: grant.id, path: "a", content: "x", edits: [{ oldText: "a", newText: "b" }] }), /either edits or content/);
});

test("an approved edit is not written once the file changes, and a resumed approval for changed content is marked stale", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "config.json");
  writeFileSync(file, "{\n  \"debug\": false\n}\n");
  const proposed = await edit({ grantId: grant.id, path: "config.json", expectedHash: hashOf(file), edits: [{ oldText: "false", newText: "true" }] });
  writeFileSync(file, "{\n  \"debug\": false,\n  \"other\": 1\n}\n");
  await assert.rejects(proposed.run(), /changed after this edit was approved/);
  assert.equal(readFileSync(file, "utf8"), "{\n  \"debug\": false,\n  \"other\": 1\n}\n");
  // The SDK validates a resumed approval again; changed content is refused there too.
  await assert.rejects(bindProjectEdit({ ...proposed.bound }), /changed since it was read/);
});

test("a preview supplied with the input is replaced by the diff computed from the file", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "a.txt");
  writeFileSync(file, "one\n");
  const honest = await edit({ grantId: grant.id, path: "a.txt", expectedHash: hashOf(file), edits: [{ oldText: "one", newText: "two" }] });
  const forged = await bindProjectEdit({ ...honest.bound, binding: { ...honest.bound.binding, diff: "+harmless", added: 0, removed: 0 } });
  assert.equal(forged.binding.diff, honest.bound.binding.diff);
  assert.equal(forged.binding.stale, undefined);
});

test("permission changes after proposal invalidate the edit", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "a.txt");
  writeFileSync(file, "one\n");
  const proposed = await edit({ grantId: grant.id, path: "a.txt", expectedHash: hashOf(file), edits: [{ oldText: "one", newText: "two" }] });
  const current = (await listGrants()).find(row => row.id === grant.id)!;
  await setTerminalPermission(grant.id, true, current.updatedAt, "full-access");
  await assert.rejects(proposed.run(), /permission changed/);
  assert.equal(readFileSync(file, "utf8"), "one\n");
  // A resumed approval under the changed permission keeps what was approved, marked stale.
  const resumed = await bindProjectEdit({ ...proposed.bound });
  assert.equal(resumed.binding.stale, true);
  assert.equal(resumed.binding.revision, proposed.bound.binding.revision);
  await assert.rejects(applyProjectEdit(editProjectFileInputSchema.parse(resumed)), /changed after this edit was proposed/);
  assert.equal(readFileSync(file, "utf8"), "one\n");
});

test("concurrent edits from the same read cannot both apply", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "count.txt");
  writeFileSync(file, "value = 1\n");
  const hash = hashOf(file);
  const first = await edit({ grantId: grant.id, path: "count.txt", expectedHash: hash, edits: [{ oldText: "1", newText: "2" }] });
  const second = await edit({ grantId: grant.id, path: "count.txt", expectedHash: hash, edits: [{ oldText: "1", newText: "3" }] });
  const results = await Promise.allSettled([first.run(), second.run()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(readFileSync(file, "utf8"), /^value = [23]\n$/);
});

test("a read-only file is reported as locked and left unchanged", async () => {
  const { root, grant } = await folder();
  const file = path.join(root, "locked.txt");
  writeFileSync(file, "keep\n");
  chmodSync(file, 0o444);
  const proposed = await edit({ grantId: grant.id, path: "locked.txt", expectedHash: hashOf(file), edits: [{ oldText: "keep", newText: "lose" }] });
  if (process.platform === "win32") {
    await assert.rejects(proposed.run(), /locked or read-only/);
    assert.equal(readFileSync(file, "utf8"), "keep\n");
  }
  assert.deepEqual(rmSync && (await import("node:fs")).readdirSync(root).filter(name => name.startsWith(".ria-edit-")), [], "no temporary file is left behind");
});

test("diff hunks follow the replaced regions, including joined lines and appends", () => {
  const before = "a\nb\nc\nd\n";
  const joined = applyEdits(before, [{ oldText: "b\n", newText: "" }]);
  assert.equal(joined.text, "a\nc\nd\n");
  assert.match(unifiedDiff("f", before, joined.text, joined.regions, 10_000).diff, /@@ -1,4 \+1,3 @@\n a\n-b\n c\n d$/);
  const merged = applyEdits(before, [{ oldText: "b", newText: "x" }, { oldText: "c", newText: "y" }]);
  const diff = unifiedDiff("f", before, merged.text, merged.regions, 10_000);
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2);
  assert.match(diff.diff, /@@ -1,4 \+1,4 @@\n a\n-b\n\+x\n-c\n\+y\n d$/);
  const long = Array.from({ length: 30 }, (_, index) => `l${index}`).join("\n") + "\n";
  const far = applyEdits(long, [{ oldText: "l2\n", newText: "L2\n" }, { oldText: "l25\n", newText: "L25\n" }]);
  assert.equal(unifiedDiff("f", long, far.text, far.regions, 10_000).diff.match(/^@@/gm)?.length, 2);
  const join = applyEdits("ax\nb\nc\n", [{ oldText: "x\n", newText: "" }]);
  assert.equal(join.text, "ab\nc\n");
  assert.match(unifiedDiff("f", "ax\nb\nc\n", join.text, join.regions, 10_000).diff, /@@ -1,3 \+1,2 @@\n-ax\n-b\n\+ab\n c$/);

  // Applying the hunks to the original reproduces the edited text, for many random edits.
  const applyHunks = (original: string, diff: string) => {
    const source = original.split("\n"); if (source.at(-1) === "") source.pop();
    const output: string[] = []; let cursor = 0;
    for (const hunk of diff.split(/^(?=@@ )/m).slice(1)) {
      const start = Number(/^@@ -(\d+)/.exec(hunk)![1]) - 1;
      while (cursor < start) output.push(source[cursor++]);
      for (const line of hunk.split("\n").slice(1)) {
        if (line.startsWith(" ")) { output.push(line.slice(1)); cursor++; }
        else if (line.startsWith("-")) cursor++;
        else if (line.startsWith("+")) output.push(line.slice(1));
      }
    }
    while (cursor < source.length) output.push(source[cursor++]);
    return output.join("\n");
  };
  let seed = 7;
  const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  let checked = 0;
  for (let round = 0; round < 300; round++) {
    const text = Array.from({ length: 1 + random(40) }, (_, index) => `row ${index} ${"x".repeat(random(4))}`).join("\n") + (random(2) ? "\n" : "");
    const start = random(text.length - 1), end = Math.min(text.length, start + 1 + random(30));
    const oldText = text.slice(start, end);
    if (text.indexOf(oldText) !== start || text.indexOf(oldText, start + 1) !== -1) continue;
    const newText = ["", "Z", "Z\n", "\nZ\nZ", "\n"][random(5)];
    const applied = applyEdits(text, [{ oldText, newText }]);
    const { diff } = unifiedDiff("f", text, applied.text, applied.regions, 1_000_000);
    const expected = applied.text.endsWith("\n") ? applied.text.slice(0, -1) : applied.text;
    assert.equal(applyHunks(text, diff), expected, `round ${round}: ${JSON.stringify({ oldText, newText })}`);
    checked++;
  }
  assert.ok(checked >= 150, `only ${checked} random edits were checked`);
  const truncated = unifiedDiff("f", null, "x\n".repeat(5000), [], 200);
  assert.match(truncated.diff, /diff truncated: \d+ more lines/);
});

test("edit tools come with terminal access, require approval only in approval mode, and feed summaries and history", async () => {
  const { root, grant } = await folder("approval");
  const chat = await db.chat.create({ data: { title: "Workspace", workspaceGrantId: grant.id } });
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"], chatId: chat.id });
  assert.ok("readProjectFile" in tools && "editProjectFile" in tools);
  assert.match(String(tools.editProjectFile.description), new RegExp(grant.id));
  assert.ok(!("editProjectFile" in await createChatToolSet({ toolIds: ["searchKnowledge"] })));
  const needsApproval = (tools.editProjectFile as unknown as { needsApproval: (input: unknown) => Promise<boolean> }).needsApproval;
  writeFileSync(path.join(root, "a.txt"), "one\n");
  const input = { grantId: grant.id, path: "a.txt", expectedHash: hashOf(path.join(root, "a.txt")), edits: [{ oldText: "one", newText: "two" }] };
  assert.equal(await needsApproval({ ...input }), true);
  const current = (await listGrants()).find(row => row.id === grant.id)!;
  await setTerminalPermission(grant.id, true, current.updatedAt, "full-access");
  assert.equal(await needsApproval({ ...input }), false);

  const { run } = await edit(input);
  const output = await run();
  const part = { type: "tool-editProjectFile", toolCallId: "e1", state: "output-available", input, output } as UIMessage["parts"][number];
  const summary = collectEditedFiles([part]);
  assert.deepEqual(summary.files.map(file => [file.path, file.kind, file.grantId]), [["a.txt", "modified", grant.id]]);
  const record = historicalToolText(part);
  assert.match(record, /"path":"a.txt"/); assert.match(record, /-one\n\+two/);
});

test("edit approvals revalidate to the identical input and cannot be altered or claimed twice", async () => {
  const { root, grant } = await folder("approval");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  const schema = asSchema(tools.editProjectFile.inputSchema);
  const proposed = await schema.validate!({ grantId: grant.id, path: "a.txt", expectedHash: hashOf(path.join(root, "a.txt")), edits: [{ oldText: "one", newText: "two" }] });
  assert.equal(proposed.success, true);
  if (!proposed.success) return;
  const input = proposed.value as { binding: { diff: string } };
  assert.match(input.binding.diff, /-one\n\+two/);
  const again = await schema.validate!(structuredClone(input));
  assert.equal(again.success, true);
  if (again.success) assert.equal(JSON.stringify(again.value), JSON.stringify(input));
  const failing = await Promise.resolve(schema.validate!({ grantId: grant.id, path: "a.txt", expectedHash: hashOf(path.join(root, "a.txt")), edits: [{ oldText: "absent", newText: "x" }] })).catch(error => error);
  assert.match(String(failing?.message ?? failing?.error), /was not found/, "an edit that cannot apply is reported before any approval");

  const chat = await db.chat.create({ data: { title: "Edit approval" } });
  const part = { type: "tool-editProjectFile", toolCallId: "edit-call", state: "approval-requested", input, approval: { id: "edit-approval" } };
  await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "assistant-edit", content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [{ ...part, toolName: "editProjectFile" }] }) } });
  const response = (changed?: unknown) => ({ id: "assistant-edit", role: "assistant" as const, parts: [{ ...part, state: "approval-responded", input: changed ?? input, approval: { ...part.approval, approved: true } }] }) as never;
  await assert.rejects(claimToolApproval(chat.id, response({ ...input, binding: { ...input.binding, diff: "+other" } })));
  await claimToolApproval(chat.id, response());
  await assert.rejects(claimToolApproval(chat.id, response()));
});
