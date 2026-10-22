import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import type { ToolSet } from "ai";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { echoSchema, startExtensionService } from "../helpers/extension-service";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { saveExtension, testExtension, activateExtension, deleteExtension, listExtensions } = await import("@/lib/extensions/store");
const { resolveToolDescriptor, listPublicToolCatalog, toolAvailability } = await import("@/tools/registry");
const { createChatToolSet } = await import("@/tools/execution");
const { chatRequestSchema } = await import("@/lib/server/request-schemas");
const routes = await import("@/app/api/extensions/route");
const itemRoute = await import("@/app/api/extensions/[id]/route");
const probeRoute = await import("@/app/api/extensions/[id]/test/route");
const toolRoute = await import("@/app/api/tools/run/route");
const { startRun } = await import("@/lib/agent/runs");
const key = randomBytes(32).toString("base64");
const toolOptions = { toolCallId: "extension-call", messages: [] };
async function approve(tool: ToolSet[string], input: unknown) {
  const gate = tool.needsApproval;
  assert.equal(typeof gate, "function");
  if (typeof gate !== "function") throw new Error("External approval gate is absent");
  return gate(input, toolOptions);
}
let cookie: string;

beforeEach(async (t: TestContext) => {
  process.env.RIA_EXTENSION_KEY = key;
  process.env.APP_RUNTIME = "test";
  globalThis.__privateAiRateLimitStore?.clear();
  cookie = localAccessCookie();
  for (const method of ["info", "error", "warn"] as const) t.mock.method(console, method, () => {});
  await db.extension.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

async function fixture(t: TestContext, type: "http" | "mcp-http" = "http", credentials?: Record<string, string>) {
  const service = await startExtensionService(); t.after(() => service.close());
  const row = await saveExtension({ name: "Fixture extension", config: type === "http" ? { type, url: `${service.origin}/http`, method: "POST", description: "Echo a test value", inputSchema: echoSchema } : { type, url: `${service.origin}/mcp` }, ...(credentials ? { credentials } : {}) });
  return { service, row };
}
async function enable(row: Awaited<ReturnType<typeof saveExtension>>) {
  const tested = await testExtension(row.id, row.revision);
  return activateExtension(row.id, { revision: tested.revision, enabled: true, tools: tested.tools.map(tool => tool.name) });
}
const request = (method: string, body?: unknown, headers: Record<string, string> = {}, auth = cookie) => new NextRequest("http://localhost/api/extensions", { method, headers: { "Content-Type": "application/json", ...(auth ? { cookie: auth } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

test("connection creation is inactive, detection executes no business call, and selected tools join the registry", async t => {
  const { service, row } = await fixture(t);
  assert.equal(row.enabled, false); assert.equal(row.tools.length, 0);
  await assert.rejects(() => activateExtension(row.id, { revision: row.revision, enabled: true, tools: [] }), /检测/);
  const enabled = await enable(row);
  assert.equal(service.state.calls.length, 0); assert.equal(service.state.probes, 1);
  assert.equal(enabled.enabled, true);
  const tool = (await listPublicToolCatalog("chat")).find(item => item.extensionId === row.id)!;
  assert.equal(tool.available, true); assert.equal(tool.manual.enabled, false);
  assert.ok(tool.id.length <= 64);
  assert.ok((await createChatToolSet())[tool.id]);
  assert.equal((await createChatToolSet({ toolIds: [] }))[tool.id], undefined);
});

test("credentials are encrypted, never returned by management, and redacted from tool output", async t => {
  const secret = "synthetic-extension-token";
  const { row, service } = await fixture(t, "http", { Authorization: `Bearer ${secret}` });
  const stored = await db.extension.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(stored.credentials); assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.equal(JSON.stringify(await listExtensions()).includes(secret), false);
  const enabled = await enable(row), id = enabled.tools[0].id;
  const tool = (await createChatToolSet())[id]; const input = { arguments: { text: "hello" } };
  await approve(tool, input);
  const output = await tool.execute!(input, toolOptions);
  assert.equal(service.state.calls[0].authorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(output).includes(secret), false);
  assert.match(JSON.stringify(output), /redacted/);
  assert.equal((output as any).result.echo, "hello");
  delete process.env.RIA_EXTENSION_KEY;
  assert.equal((await toolAvailability(id)).available, false);
  await assert.rejects(() => saveExtension({ name: "No encryption", config: row.config, credentials: { Authorization: secret } }), /加密/);
});

test("HTTP and MCP tools require bound approval and reject malformed parameters before side effects", async t => {
  for (const type of ["http", "mcp-http"] as const) {
    const { row, service } = await fixture(t, type);
    const enabled = await enable(row), id = enabled.tools[0].id;
    const tool = (await createChatToolSet())[id];
    await assert.rejects(() => tool.execute!({ arguments: { text: "unapproved" } }, toolOptions), /确认/);
    await assert.rejects(() => tool.execute!({ arguments: { wrong: true } }, toolOptions), /Invalid/);
    assert.equal(service.state.calls.length, 0);
    const input = { arguments: { text: "approved" } };
    assert.equal(await approve(tool, input), true);
    await tool.execute!(input, toolOptions);
    assert.equal(service.state.calls.length, 1);
  }
});

test("HTTP methods preserve their argument encoding and never follow a service redirect", async t => {
  const { row, service } = await fixture(t);
  assert.equal(row.config.type, "http");
  if (row.config.type !== "http") throw new Error("Expected HTTP fixture");
  let current = row;
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const edited = await saveExtension({ name: row.name, revision: current.revision, config: { ...row.config, method } }, row.id);
    current = await enable(edited);
    const tool = (await createChatToolSet())[current.tools[0].id];
    const input = { arguments: { text: "a & b/中文" } }; await approve(tool, input);
    await tool.execute!(input, toolOptions);
    assert.equal(service.state.calls.at(-1)?.method, method);
    assert.deepEqual(service.state.calls.at(-1)?.args, input.arguments);
  }
  const tool = (await createChatToolSet())[current.tools[0].id];
  const input = { arguments: { text: "redirect" } }; await approve(tool, input);
  service.state.redirect = true;
  await assert.rejects(() => tool.execute!(input, toolOptions), /扩展连接/);
  assert.equal(service.state.calls.length, 6);
});

test("unsupported schemas and ambiguous credentials fail before a connection can be saved", async t => {
  const { row } = await fixture(t);
  if (row.config.type !== "http") throw new Error("Expected HTTP fixture");
  const config = row.config;
  for (const inputSchema of [{ type: "object", properties: { text: { $ref: "https://foreign.invalid/schema" } } }, { type: "object", properties: { text: { type: "string", pattern: "(a+)+" } } }]) {
    await assert.rejects(() => saveExtension({ name: "Unsupported schema", config: { ...config, inputSchema } }));
  }
  for (const credentials of [{ Authorization: "first", authorization: "second" }, { Host: "foreign.invalid" }, { Authorization: "first\r\nOther: injected" }]) {
    await assert.rejects(() => saveExtension({ name: "Invalid headers", config: row.config, credentials }));
  }
  assert.equal((await listExtensions()).items.length, 1);
});

test("configuration edits invalidate pending approval and cannot reuse credentials at another endpoint", async t => {
  const { row, service } = await fixture(t, "http", { Authorization: "Bearer synthetic-old" });
  const enabled = await enable(row), id = enabled.tools[0].id, tool = (await createChatToolSet())[id];
  const input = { arguments: { text: "stale" } }; await approve(tool, input);
  const edited = await saveExtension({ name: row.name, config: { ...row.config, url: `${service.origin}/http/new` } as any, revision: enabled.revision }, row.id);
  assert.equal(edited.enabled, false); assert.equal(edited.hasCredentials, false);
  await assert.rejects(() => tool.execute!(input, toolOptions));
  const reenabled = await enable(edited);
  await assert.rejects(() => (createChatToolSet().then(tools => tools[reenabled.tools[0].id].execute!(input, toolOptions))), /配置|确认/);
  assert.equal(service.state.calls.length, 0);
  await assert.rejects(() => saveExtension({ name: row.name, config: row.config, revision: enabled.revision }, row.id), /变化/);
});

test("MCP definition drift is refused before execution even when a server labels its tool read-only", async t => {
  const { row, service } = await fixture(t, "mcp-http");
  const enabled = await enable(row), tool = (await createChatToolSet())[enabled.tools[0].id];
  const input = { arguments: { text: "changed" } }; await approve(tool, input);
  service.state.changed = true;
  await assert.rejects(() => tool.execute!(input, toolOptions), /定义已变化/);
  assert.equal(service.state.calls.length, 0);
  const tested = await testExtension(row.id, enabled.revision);
  assert.equal(tested.enabled, false); assert.equal(tested.tools[0].enabled, false);
});

test("disabling a connection cancels an active call and blocks every later invocation", async t => {
  const { row, service } = await fixture(t);
  const enabled = await enable(row), id = enabled.tools[0].id, tool = (await createChatToolSet())[id];
  const input = { arguments: { text: "held" } }; await approve(tool, input);
  service.state.hold = true;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); service.state.onCall = entered;
  const pending = tool.execute!(input, toolOptions); const failure = assert.rejects(() => pending, /取消|变化/);
  await started;
  await activateExtension(row.id, { revision: enabled.revision, enabled: false, tools: [] });
  await failure;
  assert.equal((await createChatToolSet())[id], undefined);
  await assert.rejects(() => tool.execute!(input, toolOptions));
  assert.equal(service.state.calls.length, 1);
});

test("deleting during detection cannot resurrect a connection or publish obsolete tools", async t => {
  const { row, service } = await fixture(t);
  service.state.hold = true;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); service.state.onProbe = entered;
  const pending = testExtension(row.id, row.revision); const failure = assert.rejects(() => pending);
  await started; await deleteExtension(row.id, row.revision); await failure;
  assert.equal((await listExtensions()).items.length, 0);
});

test("upstream failures are not retried and oversized responses are bounded", async t => {
  const { row, service } = await fixture(t);
  const enabled = await enable(row), tool = (await createChatToolSet())[enabled.tools[0].id];
  const input = { arguments: { text: "failure" } }; await approve(tool, input);
  service.state.fail = true;
  await assert.rejects(() => tool.execute!(input, toolOptions), /HTTP 503/);
  assert.equal(service.state.calls.length, 1);
  service.state.fail = false; service.state.oversized = true;
  await assert.rejects(() => tool.execute!(input, toolOptions), /512 KiB/);
  assert.equal(service.state.calls.length, 2);
});

test("an external tool transcript remains readable after uninstall while unknown built-in names stay rejected", async t => {
  const { row } = await fixture(t); const enabled = await enable(row), id = enabled.tools[0].id;
  await deleteExtension(row.id, enabled.revision);
  const body = { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "earlier" }] }, { id: "a1", role: "assistant", parts: [{ type: `tool-${id}`, toolCallId: "c1", state: "output-available", input: { arguments: { text: "hello" } }, output: { echo: "hello" } }] }, { id: "u2", role: "user", parts: [{ type: "text", text: "continue" }] }] };
  assert.equal(chatRequestSchema.safeParse(body).success, true);
  body.messages[1].parts[0].type = "tool-notInstalled";
  assert.equal(chatRequestSchema.safeParse(body).success, false);
  assert.equal(await resolveToolDescriptor(id), null);
});

test("management routes require the local credential and reject foreign origins and oversized bodies", async () => {
  assert.equal((await routes.GET(request("GET", undefined, {}, ""))).status, 401);
  assert.equal((await routes.POST(request("POST", {}, { origin: "https://foreign.invalid" }))).status, 403);
  assert.equal((await routes.POST(request("POST", { name: "x".repeat(150_000) }))).status, 413);
  const nonexistent = "00000000-0000-4000-8000-000000000001";
  for (const handler of [itemRoute.PUT, itemRoute.PATCH, itemRoute.DELETE, probeRoute.POST]) assert.equal((await handler(request("POST", { revision: 1 }, {}, ""), context(nonexistent))).status, 401);
});

test("manual invocation cannot bypass external approval", async t => {
  const { row } = await fixture(t); const enabled = await enable(row);
  const response = await toolRoute.POST(new NextRequest("http://localhost/api/tools/run", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ tool: enabled.tools[0].id, mode: "chat", input: { arguments: { text: "bypass" } } }) }));
  assert.equal(response.status, 400);
});

test("assistant templates accept external tools, retain their allowlist and can remove an uninstalled tool", async t => {
  const { row } = await fixture(t), enabled = await enable(row), id = enabled.tools[0].id;
  const { saveAssistant, resolveAssistant } = await import("@/lib/assistants/store");
  const { assistantConfigSchema } = await import("@/lib/assistants/schema");
  const config = assistantConfigSchema.parse({ name: "External assistant", instructions: "Use only the selected tool.", tools: [id] });
  const template = await saveAssistant(config);
  const snapshot = await resolveAssistant(template.id);
  // Context compaction accompanies any available tool and grants no capability.
  assert.deepEqual(Object.keys(await createChatToolSet({ toolIds: snapshot.tools })), ["compactContext", id]);
  await activateExtension(row.id, { revision: enabled.revision, enabled: false, tools: [enabled.tools[0].name] });
  assert.deepEqual(Object.keys(await createChatToolSet({ toolIds: snapshot.tools })), []);
  const latest = (await listExtensions()).items[0]; await deleteExtension(row.id, latest.revision);
  assert.deepEqual((await resolveAssistant(template.id)).tools, [id]);
  await saveAssistant({ ...config, tools: [] }, template.id, template.revision);
  assert.deepEqual((await resolveAssistant(template.id)).tools, []);
});

test("deletion uses the existing bodyless DELETE contract and requires the current revision", async t => {
  const { row } = await fixture(t);
  const remove = (revision: number) => itemRoute.DELETE(new NextRequest(`http://localhost/api/extensions/${row.id}?revision=${revision}`, { method: "DELETE", headers: { cookie } }), context(row.id));
  assert.equal((await remove(row.revision + 1)).status, 409);
  assert.equal((await listExtensions()).items.length, 1);
  assert.equal((await remove(row.revision)).status, 200);
  assert.equal((await listExtensions()).items.length, 0);
});

test("stdio connects to an installed executable without inheriting app secrets and cleans up its process", async t => {
  const root = mkdtempSync(join(tmpdir(), "ria-mcp-process-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const pidFile = join(root, "pid.txt"); process.env.LOCAL_ACCESS_TOKEN = "synthetic-parent-token";
  const row = await saveExtension({ name: "Local echo", config: { type: "mcp-stdio", command: process.execPath, args: [resolve("tests/fixtures/mcp-echo.mjs"), pidFile], cwd: root, processPermission: true }, credentials: { FIXTURE_TOKEN: "synthetic-child-token" } });
  const enabled = await enable(row), tool = (await createChatToolSet())[enabled.tools[0].id];
  const firstPid = Number(readFileSync(pidFile, "utf8")); assert.throws(() => process.kill(firstPid, 0));
  const input = { arguments: { text: "local" } }; await approve(tool, input);
  const output = await tool.execute!(input, toolOptions) as any;
  const result = JSON.parse(output.result.content[0].text);
  assert.equal(result.text, "local"); assert.equal(result.leakedAppKey, false); assert.equal(result.leakedAccess, false); assert.equal(result.ownToken, "[redacted]");
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
  await assert.rejects(() => saveExtension({ name: "Shell", config: { type: "mcp-stdio", command: "cmd.exe", args: [], cwd: root, processPermission: true } }), /绝对路径/);
  process.env.APP_RUNTIME = "development";
  assert.equal((await toolAvailability(enabled.tools[0].id)).available, false);
  assert.equal((await createChatToolSet())[enabled.tools[0].id], undefined);
  await assert.rejects(() => testExtension(row.id, enabled.revision), /桌面应用/);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0));
});

test("external calls share execution records and the existing atomic run budget", async t => {
  const { row, service } = await fixture(t); const enabled = await enable(row), id = enabled.tools[0].id;
  const run = await startRun({ chatId: null, goal: "External execution evidence", budget: { maxSteps: 1 } });
  const tool = (await createChatToolSet({ runId: run.id }))[id];
  const input = { arguments: { text: "recorded" } }; await approve(tool, input);
  await tool.execute!(input, toolOptions); await tool.execute!(input, toolOptions);
  assert.equal(service.state.calls.length, 1);
  const steps = await db.agentStep.findMany({ where: { runId: run.id } });
  assert.equal(steps.length, 1); assert.equal(steps[0].state, "done"); assert.equal(steps[0].toolName, id);
});

test("a stalled external operation reaches its real deadline without retrying", { timeout: 35_000 }, async t => {
  const { row, service } = await fixture(t); const enabled = await enable(row), tool = (await createChatToolSet())[enabled.tools[0].id];
  const input = { arguments: { text: "timeout" } }; await approve(tool, input);
  service.state.hold = true; const started = performance.now();
  await assert.rejects(() => tool.execute!(input, toolOptions), /超时/);
  assert.ok(performance.now() - started >= 19_000);
  assert.equal(service.state.calls.length, 1);
});
