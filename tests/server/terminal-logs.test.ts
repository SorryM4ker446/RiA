import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { UIMessage } from "ai";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { bindTerminalApproval, runTerminalCommand } = await import("@/lib/terminal/runtime");
const { TERMINAL_LIMITS } = await import("@/lib/terminal/schema");
const { terminalResultForModel } = await import("@/lib/terminal/model-output");
const { TERMINAL_LOG_LIMITS, pruneTerminalLogs, readTerminalLog, terminalLogRoot } = await import("@/lib/terminal/logs");
const { terminalGrant } = await import("@/lib/terminal/runtime");
const { createChatToolSet } = await import("@/tools/catalog");
const { startRun } = await import("@/lib/agent/runs");
const { historicalToolText } = await import("@/lib/chat/tool-history");
const { deleteConversations } = await import("@/lib/conversations/mutations");

const roots: string[] = [];
const win = process.platform === "win32";
const defaults = { ...TERMINAL_LOG_LIMITS };
async function folder() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-terminal-log-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  return (await listGrants()).find(row => row.id === grant.id)!;
}
// 20,000 numbered lines with one diagnostic in the middle, then a final summary on stdout and a stderr line.
const bigOutput = win
  ? "1..20000 | ForEach-Object { if ($_ -eq 10000) { 'src/app.ts:42 error TS2304: middle-marker' } else { \"line $_\" } }; 'Tests: 3 failed'; [Console]::Error.WriteLine('stderr-marker')"
  : "i=1; while [ $i -le 20000 ]; do if [ $i -eq 10000 ]; then echo 'src/app.ts:42 error TS2304: middle-marker'; else echo \"line $i\"; fi; i=$((i+1)); done; echo 'Tests: 3 failed'; echo stderr-marker >&2";
async function run(grantId: string, command: string, runId?: string | null) {
  return runTerminalCommand(await bindTerminalApproval({ grantId, command }), undefined, runId);
}
const allow = (grantId: string) => terminalGrant(grantId);

beforeEach(async () => {
  process.env.APP_RUNTIME = "test";
  Object.assign(TERMINAL_LOG_LIMITS, defaults);
  rmSync(terminalLogRoot(), { recursive: true, force: true });
});
after(async () => {
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== realpathSync.native(tmpdir()) || !path.basename(root).startsWith("ria-terminal-log-")) throw new Error("Unexpected terminal test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});

test("output beyond the capture keeps its beginning and end in memory and all of it in a readable log", { timeout: 60_000 }, async () => {
  const grant = await folder();
  const result = await run(grant.id, bigOutput);
  assert.equal(result.status, "completed"); assert.equal(result.truncated, true);
  assert.match(result.stdout, /^line 1\r?\n/);
  assert.match(result.stdout, /Tests: 3 failed\s*$/, "the end of the output is still captured");
  assert.match(result.stdout, /bytes omitted from this capture/);
  assert.doesNotMatch(result.stdout, /middle-marker/);
  assert.match(result.stderr, /stderr-marker/);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= TERMINAL_LIMITS.outputBytes + 200);
  assert.ok(result.log); assert.equal(result.log.id, result.id); assert.equal(result.log.complete, true);
  assert.ok(result.log.stdoutBytes > TERMINAL_LIMITS.outputBytes);

  const found = await readTerminalLog({ logId: result.log.id, stream: "stdout", startLine: 1, lineCount: 200, search: "MIDDLE-MARKER" }, allow);
  assert.deepEqual(found.lines.map(line => line.line), [10000]);
  assert.equal(found.totalLines, 20001); assert.equal(found.complete, true); assert.equal(found.nextLine, null);
  // A search returns as many matches as were asked for, and says where the next one is.
  const two = await readTerminalLog({ logId: result.log.id, stream: "stdout", startLine: 1, lineCount: 2, search: "line 1" }, allow);
  assert.deepEqual(two.lines.map(line => line.line), [1, 10]);
  assert.equal(two.nextLine, 11);
  const following = await readTerminalLog({ logId: result.log.id, stream: "stdout", startLine: two.nextLine!, lineCount: 2, search: "line 1" }, allow);
  assert.deepEqual(following.lines.map(line => line.line), [11, 12]);
  // Asked for more than a search gives, it still stops at the search's own limit.
  const many = await readTerminalLog({ logId: result.log.id, stream: "stdout", startLine: 1, lineCount: 500, search: "line" }, allow);
  assert.equal(many.lines.length, TERMINAL_LOG_LIMITS.searchMatches);
  assert.equal(many.nextLine, many.lines.at(-1)!.line + 1);
  const around = await readTerminalLog({ logId: result.log.id, stream: "stdout", startLine: 9999, lineCount: 3 }, allow);
  assert.deepEqual(around.lines.map(line => line.text.trim()), ["line 9999", "src/app.ts:42 error TS2304: middle-marker", "line 10001"]);
  assert.equal(around.nextLine, 10002);
  const errors = await readTerminalLog({ logId: result.log.id, stream: "stderr", startLine: 1, lineCount: 10 }, allow);
  assert.match(errors.lines[0].text, /stderr-marker/);

  const page = await readTerminalLog({ logId: result.log.id, stream: "stdout", startLine: 1, lineCount: TERMINAL_LOG_LIMITS.readLines }, allow);
  assert.equal(page.lines.length, TERMINAL_LOG_LIMITS.readLines); assert.equal(page.nextLine, TERMINAL_LOG_LIMITS.readLines + 1);

  // The history record a later step or summary receives names the log.
  const record = historicalToolText({ type: "tool-runTerminalCommand", toolCallId: "big", state: "output-available", input: { command: "build" }, output: result } as UIMessage["parts"][number]);
  assert.ok(record.includes(result.log.id));
});

test("short output leaves no log behind and reaches the model whole", async () => {
  const grant = await folder();
  const result = await run(grant.id, win ? "'small output'" : "echo 'small output'");
  assert.equal(result.truncated, false); assert.equal(result.log, undefined);
  assert.equal(existsSync(path.join(terminalLogRoot(), result.id)), false);
  assert.deepEqual(terminalResultForModel(result), result);
});

test("output longer than the model is sent keeps a log, and the model reads its beginning and end with where the rest is", { timeout: 60_000 }, async () => {
  const grant = await folder();
  // About 30 KB: whole in the card's capture, more than the model's share.
  const result = await run(grant.id, win
    ? "1..1200 | ForEach-Object { if ($_ -eq 600) { 'FAIL refunds keep the shipping fee' } else { \"ok line $_ of the test run\" } }"
    : "i=1; while [ $i -le 1200 ]; do if [ $i -eq 600 ]; then echo 'FAIL refunds keep the shipping fee'; else echo \"ok line $i of the test run\"; fi; i=$((i+1)); done");
  assert.equal(result.status, "completed");
  assert.equal(result.truncated, false, "the card still shows all of it");
  assert.match(result.stdout, /FAIL refunds/);
  assert.ok(result.log, "a log is kept for the part the model is not sent");
  const shown = terminalResultForModel(result);
  assert.ok(Buffer.byteLength(shown.stdout) <= TERMINAL_LIMITS.modelOutputBytes + 300);
  assert.match(shown.stdout, /^ok line 1 /);
  assert.match(shown.stdout, /ok line 1200 of the test run\s*$/);
  assert.doesNotMatch(shown.stdout, /FAIL refunds/, "the middle is left out");
  assert.match(shown.stdout, new RegExp(`bytes of this output are not shown here; read them with readTerminalLog \\(logId ${result.log!.id}\\)`));
  // The left-out middle is in the log.
  const found = await readTerminalLog({ logId: result.log!.id, stream: "stdout", startLine: 1, lineCount: 5, search: "FAIL" }, allow);
  assert.deepEqual(found.lines.map(line => line.line), [600]);
  // A short error stream beside a long log is shown whole.
  const both = terminalResultForModel({ ...result, stderr: "Error: one line on stderr" });
  assert.equal(both.stderr, "Error: one line on stderr");
});

test("a log that reaches its size limit is marked incomplete without failing the command", { timeout: 60_000 }, async () => {
  TERMINAL_LOG_LIMITS.bytesPerCommand = 100_000;
  const grant = await folder();
  const result = await run(grant.id, bigOutput);
  assert.equal(result.status, "completed"); assert.equal(result.exitCode, 0);
  assert.equal(result.log?.complete, false);
  assert.ok(result.log!.stdoutBytes + result.log!.stderrBytes <= 100_000);
  const read = await readTerminalLog({ logId: result.log!.id, stream: "stdout", startLine: 1, lineCount: 5 }, allow);
  assert.equal(read.complete, false);
});

test("logs are readable only with terminal access and are removed when access ends", { timeout: 60_000 }, async () => {
  const grant = await folder();
  const result = await run(grant.id, bigOutput);
  // Withdrawing the folder removes its saved logs.
  await revokeGrant(grant.id);
  await assert.rejects(readTerminalLog({ logId: result.log!.id, stream: "stdout", startLine: 1, lineCount: 5 }, allow), { code: "NOT_FOUND" });
  assert.equal(existsSync(path.join(terminalLogRoot(), result.id)), false);

  const other = await folder();
  const kept = await run(other.id, bigOutput);
  await revokeGrant(other.id);
  assert.equal(existsSync(path.join(terminalLogRoot(), kept.id)), false);
  await assert.rejects(readTerminalLog({ logId: crypto.randomUUID(), stream: "stdout", startLine: 1, lineCount: 5 }, allow), { code: "NOT_FOUND" });
});

test("pruning removes expired logs, logs of deleted conversations and, oldest first, finished logs beyond the total size", { timeout: 90_000 }, async () => {
  const grant = await folder();
  const chat = await db.chat.create({ data: { title: "Owns a log" } });
  const owned = await startRun({ chatId: chat.id, goal: "Owned log" });
  const ownedLog = await run(grant.id, bigOutput, owned.id);
  const expired = await run(grant.id, bigOutput);
  const metaFile = path.join(terminalLogRoot(), expired.id, "meta.json");
  writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, "utf8")), expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await assert.rejects(readTerminalLog({ logId: expired.id, stream: "stdout", startLine: 1, lineCount: 5 }, allow), { code: "NOT_FOUND" });
  await deleteConversations([chat.id]);
  assert.equal(existsSync(path.join(terminalLogRoot(), ownedLog.id)), false, "the deleted conversation's log is removed");
  assert.equal(existsSync(path.join(terminalLogRoot(), expired.id)), false, "the expired log is removed");

  const older = await run(grant.id, bigOutput);
  const newer = await run(grant.id, bigOutput);
  // A log without finishedAt may belong to a running command and is never removed for space.
  const running = path.join(terminalLogRoot(), "00000000-0000-4000-8000-000000000000");
  mkdirSync(running, { recursive: true });
  writeFileSync(path.join(running, "meta.json"), JSON.stringify({ id: path.basename(running), grantId: grant.id, runId: null, stdoutBytes: 1_000_000, stderrBytes: 0, complete: true,
    createdAt: new Date(0).toISOString(), finishedAt: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  TERMINAL_LOG_LIMITS.totalBytes = newer.log!.stdoutBytes + newer.log!.stderrBytes + 1_000_000;
  await pruneTerminalLogs();
  assert.equal(existsSync(path.join(terminalLogRoot(), older.id)), false, "the oldest finished log goes first");
  assert.equal(existsSync(path.join(terminalLogRoot(), newer.id)), true);
  assert.equal(existsSync(running), true);
});

test("the log reader is offered exactly where terminal commands are", async () => {
  await folder();
  const restricted = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  assert.ok("readTerminalLog" in restricted);
  const without = await createChatToolSet({ toolIds: ["searchKnowledge"] });
  assert.ok(!("readTerminalLog" in without));
  assert.ok("readTerminalLog" in await createChatToolSet());
});
