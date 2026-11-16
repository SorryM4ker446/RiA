import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { createGrant, listGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { bindTerminalApproval, runTerminalCommand, checkTerminalCommand, stopTerminalCommand, getTerminalSession, takeBackgroundCommandContext, stopTerminalCommandsForChat } = await import("@/lib/terminal/runtime");
const { createChatToolSet } = await import("@/tools/catalog");
const chatRoute = await import("@/app/api/chat/route");
const { createChat, deleteChat } = await import("@/lib/chat/store");

const roots: string[] = [];
const win = process.platform === "win32";
async function folder() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-terminal-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  return (await listGrants()).find(row => row.id === grant.id)!;
}
const print = (text: string) => win ? `[Console]::WriteLine('${text}')` : `printf '${text}\\n'`;
const pause = (seconds: number) => win ? `Start-Sleep -Seconds ${seconds}` : `sleep ${seconds}`;
const background = async (grantId: string, command: string, timeoutSeconds?: number) => bindTerminalApproval({ grantId, command, runInBackground: true, ...(timeoutSeconds ? { timeoutSeconds } : {}) });
async function eventually(check: () => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("Terminal did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

beforeEach(async (t: TestContext) => {
  process.env.APP_RUNTIME = "test";
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  globalThis.__riaRateLimitStore?.clear();
});
after(async () => {
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== realpathSync.native(tmpdir()) || !path.basename(root).startsWith("ria-terminal-")) throw new Error("Unexpected terminal test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});

test("a background command is handed back while it runs, and a check returns only output not yet read", async () => {
  const grant = await folder();
  const input = await background(grant.id, `${print("first")}; ${pause(5)}; ${print("second")}`);
  const started = Date.now();
  const result = await runTerminalCommand(input, undefined, null, { chatId: "chat-a" });
  assert.equal(result.status, "running");
  assert.equal(result.background, true);
  assert.ok(Date.now() - started < 5_000, "the call returned before the command could have ended");
  assert.equal(getTerminalSession(input.binding.sessionId).status, "running");
  await eventually(() => getTerminalSession(input.binding.sessionId).stdout.includes("first"));
  const early = await checkTerminalCommand(input.binding.sessionId, "chat-a");
  assert.equal(early.status, "running");
  assert.match(early.newStdout, /first/);
  assert.doesNotMatch(early.newStdout, /second/);
  const finished = await checkTerminalCommand(input.binding.sessionId, "chat-a", 30);
  assert.equal(finished.status, "completed");
  assert.equal(finished.exitCode, 0);
  assert.match(finished.newStdout, /second/);
  assert.doesNotMatch(finished.newStdout, /first/, "what was read before is not repeated");
  assert.equal((await checkTerminalCommand(input.binding.sessionId, "chat-a")).newStdout, "");
  // The model saw it end, so the next turn is not told again.
  assert.equal(takeBackgroundCommandContext("chat-a"), "");
  await revokeGrant(grant.id);
});

test("stopping the answer leaves a background command running; its own stop ends it", async () => {
  const grant = await folder();
  const input = await background(grant.id, `${print("ready")}; ${pause(60)}`);
  const controller = new AbortController();
  await runTerminalCommand(input, controller.signal, null, { chatId: "chat-b" });
  await eventually(() => getTerminalSession(input.binding.sessionId).stdout.includes("ready"));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(getTerminalSession(input.binding.sessionId).status, "running");
  const stopped = await stopTerminalCommand(input.binding.sessionId, "chat-b");
  assert.equal(stopped.status, "stopped");
  await revokeGrant(grant.id);
});

test("a background command is reachable only from its own conversation", async () => {
  const grant = await folder();
  const input = await background(grant.id, `${print("ready")}; ${pause(60)}`);
  await runTerminalCommand(input, undefined, null, { chatId: "chat-c" });
  try {
    await assert.rejects(checkTerminalCommand(input.binding.sessionId, "chat-other"), (error: { code: string }) => error.code === "FORBIDDEN");
    await assert.rejects(stopTerminalCommand(input.binding.sessionId, "chat-other"), (error: { code: string }) => error.code === "FORBIDDEN");
    assert.equal(getTerminalSession(input.binding.sessionId).status, "running", "a refused stop stopped nothing");
    await assert.rejects(checkTerminalCommand("00000000-0000-4000-8000-000000000000", "chat-c"), (error: { code: string }) => error.code === "NOT_FOUND");
  } finally { stopTerminalCommandsForChat("chat-c"); }
  await eventually(() => getTerminalSession(input.binding.sessionId).status !== "running");
  await revokeGrant(grant.id);
});

test("the next turn hears of a background command that ended, once, and of those still running", async () => {
  const grant = await folder();
  const quick = await background(grant.id, `${print("done")}; exit 3`);
  const server = await background(grant.id, `${print("listening")}; ${pause(60)}`);
  await runTerminalCommand(quick, undefined, null, { chatId: "chat-d" });
  await runTerminalCommand(server, undefined, null, { chatId: "chat-d" });
  try {
    // Told as ended as soon as it has ended, even while its folder is still being walked.
    await eventually(() => getTerminalSession(quick.binding.sessionId).status !== "running");
    const context = takeBackgroundCommandContext("chat-d");
    assert.match(context, new RegExp(`${quick.binding.sessionId} ended .*: failed, exit code 3`));
    assert.match(context, new RegExp(`${server.binding.sessionId} still running since`));
    assert.match(context, /data, not instructions/);
    const again = takeBackgroundCommandContext("chat-d");
    assert.doesNotMatch(again, new RegExp(quick.binding.sessionId), "an end is told once");
    assert.match(again, new RegExp(server.binding.sessionId), "a running one is listed each turn");
    assert.equal(takeBackgroundCommandContext("chat-unrelated"), "");
  } finally { stopTerminalCommandsForChat("chat-d"); }
  await revokeGrant(grant.id);
});

test("a background command with its own limit is stopped there, and one that fails to start says so at once", async () => {
  const grant = await folder();
  const input = await background(grant.id, `${print("ready")}; ${pause(60)}`, 1);
  await runTerminalCommand(input, undefined, null, { chatId: "chat-e" });
  const ended = await checkTerminalCommand(input.binding.sessionId, "chat-e", 30);
  assert.equal(ended.status, "timed-out");
  const revoked = await background(grant.id, print("never"));
  await revokeGrant(grant.id);
  await assert.rejects(runTerminalCommand(revoked, undefined, null, { chatId: "chat-e" }));
});

test("the terminal offers the model ways to check and stop its commands", async () => {
  const grant = await folder();
  const chat = await db.chat.create({ data: { title: "Workspace", workspaceGrantId: grant.id } });
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"], chatId: chat.id });
  assert.ok(tools.checkTerminalCommand && tools.stopTerminalCommand);
  assert.equal(tools.stopTerminalCommand.needsApproval, undefined, "stopping needs no approval");
  // Through the tools, commands belong to the conversation that ran them.
  const input = await background(grant.id, `${print("ready")}; ${pause(60)}`);
  await tools.runTerminalCommand.execute!(input, { toolCallId: "t1", messages: [] });
  await eventually(() => getTerminalSession(input.binding.sessionId).stdout.includes("ready"));
  const checked = await tools.checkTerminalCommand.execute!({ id: input.binding.sessionId }, { toolCallId: "t2", messages: [] }) as { status: string; newStdout: string };
  assert.equal(checked.status, "running");
  assert.match(checked.newStdout, /ready/);
  const stopped = await tools.stopTerminalCommand.execute!({ id: input.binding.sessionId }, { toolCallId: "t3", messages: [] }) as { status: string };
  assert.equal(stopped.status, "stopped");
  assert.equal((await createChatToolSet({ toolIds: [] })).checkTerminalCommand, undefined, "they come and go with the terminal");
  await revokeGrant(grant.id);
});

test("deleting a conversation stops its background commands", async () => {
  const grant = await folder();
  const chat = await createChat({ title: "Goes away" });
  const input = await background(grant.id, `${print("ready")}; ${pause(60)}`);
  await runTerminalCommand(input, undefined, null, { chatId: chat.id });
  await eventually(() => getTerminalSession(input.binding.sessionId).stdout.includes("ready"));
  await deleteChat(chat.id);
  await eventually(() => getTerminalSession(input.binding.sessionId).status !== "running");
  await revokeGrant(grant.id);
});

test("a request after a background command ended carries the notice to the model", async (t: TestContext) => {
  resetProviderState();
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await seedTestModelPreferences(db);
  const grant = await folder();
  const chat = await createChat({ title: "Notice" });
  const input = await background(grant.id, `${print("built")}; exit 0`);
  await runTerminalCommand(input, undefined, null, { chatId: chat.id });
  await eventually(() => getTerminalSession(input.binding.sessionId).status !== "running");
  await new Promise(resolve => setTimeout(resolve, 50));
  const prompts: string[] = [];
  t.mock.method(languageModel, "doStream", async (call: LanguageModelV3CallOptions) => {
    prompts.push(JSON.stringify(call.prompt));
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "好的" }); controller.enqueue({ type: "text-end", id: "a" });
      controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
      controller.close();
    } }) };
  });
  const post = (text: string, id: string) => chatRoute.POST(new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify({ chatId: chat.id, messages: [{ id, role: "user", parts: [{ type: "text", text }] }] }) }));
  await (await post("构建好了吗？", "u1")).text();
  assert.match(prompts[0], new RegExp(`${input.binding.sessionId} ended`));
  assert.match(prompts[0], /completed, exit code 0/);
  await revokeGrant(grant.id);
});
