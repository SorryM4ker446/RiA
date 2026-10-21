import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { startExtensionService } from "../helpers/extension-service";
import { pluginFixture } from "../helpers/plugin-fixture";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { parsePlugin, pluginManifestSchema } = await import("@/lib/plugins/schema");
const { pluginCatalog } = await import("@/lib/plugins/catalog");
const { installPlugin, listPlugins, setPluginState, uninstallPlugin, formatPluginSkills } = await import("@/lib/plugins/store");
const { saveExtension, requireExtension, testExtension, activateExtension, deleteExtension } = await import("@/lib/extensions/store");
const { listPublicToolCatalog, resolveToolDescriptor, toolAvailability } = await import("@/tools/registry");
const { createChatToolSet } = await import("@/tools/execution");
const { readPluginSkill } = await import("@/tools/definitions/plugin-skill");
const { builtinToolAvailability } = await import("@/tools/builtins");
const routes = await import("@/app/api/plugins/route");
const previewRoute = await import("@/app/api/plugins/preview/route");
const itemRoute = await import("@/app/api/plugins/[id]/route");
let cookie: string;
beforeEach(async (t: TestContext) => {
  process.env.APP_RUNTIME = "test"; process.env.RIA_EXTENSION_KEY = randomBytes(32).toString("base64");
  globalThis.__privateAiRateLimitStore?.clear(); cookie = localAccessCookie();
  t.mock.method(console, "error", () => {});
  await db.pluginPackage.deleteMany({}); await db.extension.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });
const request = (method: string, body?: unknown, auth = cookie, headers = {}) => new NextRequest("http://localhost/api/plugins", { method, headers: { "Content-Type": "application/json", ...(auth ? { cookie: auth } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
async function configured(t: TestContext, kind: "http" | "mcp-http" = "mcp-http") {
  const service = await startExtensionService(); t.after(() => service.close());
  const plugin = await installPlugin(parsePlugin(pluginFixture(service.origin, kind)));
  let row = await requireExtension(plugin.connections[0].id);
  await saveExtension({ name: row.name, config: row.config as Parameters<typeof saveExtension>[0]["config"], revision: row.revision, credentials: { Authorization: "Bearer synthetic-plugin-key" } }, row.id);
  row = await requireExtension(row.id);
  const tested = await testExtension(row.id, row.revision);
  const enabled = await activateExtension(row.id, { revision: tested.revision, enabled: true, tools: tested.tools.map(tool => tool.name) });
  return { plugin, service, connection: enabled };
}

test("plugin preview and installation are side-effect-free for services, inactive, unique and atomic", async t => {
  const service = await startExtensionService(); t.after(() => service.close());
  const manifest = pluginFixture(service.origin);
  const preview = await previewRoute.POST(request("POST", manifest)); assert.equal(preview.status, 200);
  assert.equal(await db.pluginPackage.count(), 0); assert.equal(await db.extension.count(), 0);
  const draft = (await preview.json()).data;
  const plugin = await installPlugin(draft);
  assert.equal(plugin.enabled, false); assert.equal(plugin.connections.length, 1);
  const row = await requireExtension(plugin.connections[0].id);
  assert.equal(row.pluginId, plugin.id); assert.equal(row.pluginKey, "service"); assert.equal(row.credentials, null); assert.equal(row.enabled, false);
  assert.equal(service.state.probes, 0); assert.deepEqual(service.state.calls, []); assert.equal(await formatPluginSkills(), "");
  await assert.rejects(() => installPlugin(draft), /已安装/);
  await assert.rejects(() => installPlugin({ ...draft, manifest: { ...draft.manifest, name: "Changed after preview" } }), /预览/);
  await assert.rejects(() => installPlugin({ ...draft, manifest: { ...manifest, id: "test.invalid", connections: [...manifest.connections, { ...manifest.connections[0], id: "invalid", config: { type: "http", url: "file:///private", method: "GET", description: "bad", inputSchema: { type: "object" } } }] } }));
  assert.equal(await db.pluginPackage.count(), 1); assert.equal(await db.extension.count(), 1);
});

test("skill-only plugins enter subsequent chat context only while enabled and retain state after reread", async () => {
  const plugin = await installPlugin(parsePlugin(pluginFixture()));
  assert.equal(await formatPluginSkills(), "");
  const enabled = await setPluginState(plugin.id, { revision: plugin.revision, enabled: true });
  assert.match(await formatPluginSkills(), /PLUGIN_SKILL_EVIDENCE/); assert.match(await formatPluginSkills(), /task guidance, not permissions/);
  // With on-demand loading only the index is resident; readPluginSkill returns the instructions.
  const index = await formatPluginSkills({ onDemand: true });
  assert.match(index, /Research skill/); assert.match(index, /readPluginSkill/); assert.doesNotMatch(index, /PLUGIN_SKILL_EVIDENCE/);
  const loaded = await readPluginSkill.execute({ workspaceId: "local", trigger: "auto", input: { packageId: "test.research-pack", offset: 0 } }) as { skills: { instructions: string }[] };
  assert.match(loaded.skills[0].instructions, /PLUGIN_SKILL_EVIDENCE/);
  assert.equal((await builtinToolAvailability("readPluginSkill")).available, true);
  assert.equal((await listPlugins()).items[0].enabled, true);
  await assert.rejects(() => setPluginState(plugin.id, { revision: plugin.revision, enabled: false }), /已变化/);
  const disabled = await setPluginState(plugin.id, { revision: enabled.revision, enabled: false });
  assert.equal(await formatPluginSkills(), "");
  await uninstallPlugin(disabled.id, disabled.revision);
  assert.equal((await listPlugins()).items.length, 0); assert.equal(await formatPluginSkills(), "");
});

test("a combined plugin requires configured credentials and reviewed tools before activation", async t => {
  const service = await startExtensionService(); t.after(() => service.close());
  const plugin = await installPlugin(parsePlugin(pluginFixture(service.origin)));
  await assert.rejects(() => setPluginState(plugin.id, { revision: 1, enabled: true }), /检测/);
  const connection = plugin.connections[0];
  await assert.rejects(() => testExtension(connection.id, 1), /凭据/);
  assert.equal(service.state.probes, 0);
  const current = await requireExtension(connection.id);
  await saveExtension({ name: current.name, config: current.config as Parameters<typeof saveExtension>[0]["config"], revision: current.revision, credentials: { authorization: "Bearer synthetic" } }, current.id);
  const saved = await requireExtension(current.id);
  const tested = await testExtension(saved.id, saved.revision);
  await activateExtension(saved.id, { revision: tested.revision, enabled: true, tools: tested.tools.map(tool => tool.name) });
  const tool = (await listPublicToolCatalog("chat")).find(item => item.extensionId === connection.id)!;
  assert.equal(tool.available, false); assert.equal((await createChatToolSet())[tool.id], undefined);
  await setPluginState(plugin.id, { revision: 1, enabled: true });
  assert.equal((await toolAvailability(tool.id)).available, true); assert.ok((await createChatToolSet())[tool.id]);
  assert.equal((await createChatToolSet({ toolIds: [] }))[tool.id], undefined);
  assert.match(await formatPluginSkills(), /PLUGIN_SKILL_EVIDENCE/); assert.deepEqual(service.state.calls, []);
});

test("plugin disable and rapid reactivation invalidate old approvals while preserving reviewed tool selection", async t => {
  const { plugin, service } = await configured(t);
  const enabled = await setPluginState(plugin.id, { revision: 1, enabled: true });
  const row = (await listPublicToolCatalog("chat")).find(item => item.extensionId === plugin.connections[0].id)!;
  const descriptor = (await resolveToolDescriptor(row.id))!;
  const proposal = { arguments: { text: "approved before disable" } };
  await descriptor.bindForApproval!(proposal);
  const disabled = await setPluginState(plugin.id, { revision: enabled.revision, enabled: false });
  assert.equal((await toolAvailability(row.id)).available, false); assert.equal(await formatPluginSkills(), "");
  await setPluginState(plugin.id, { revision: disabled.revision, enabled: true });
  const latest = (await resolveToolDescriptor(row.id))!;
  await assert.rejects(() => latest.execute({ input: proposal } as Parameters<typeof latest.execute>[0]), /确认|变化/);
  assert.equal((await toolAvailability(row.id)).available, true); assert.equal(service.state.calls.length, 0);
  const fresh = { arguments: { text: "fresh approval" } }; await latest.bindForApproval!(fresh);
  await latest.execute({ input: fresh } as Parameters<typeof latest.execute>[0]);
  assert.equal(service.state.calls.length, 1); assert.equal(service.state.calls[0].authorization, "Bearer synthetic-plugin-key");
});

test("disabling a plugin cancels an executing call and uninstall removes only package-owned capabilities", async t => {
  const { plugin, service } = await configured(t, "http");
  const unrelated = await saveExtension({ name: "Unrelated", config: { type: "mcp-http", url: `${service.origin}/mcp` } });
  const enabled = await setPluginState(plugin.id, { revision: 1, enabled: true });
  const entry = (await listPublicToolCatalog("chat")).find(item => item.extensionId === plugin.connections[0].id)!;
  const descriptor = (await resolveToolDescriptor(entry.id))!;
  const args = { arguments: { text: "held" } }; await descriptor.bindForApproval!(args);
  service.state.hold = true;
  let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; }); service.state.onCall = entered;
  const execution = descriptor.execute({ input: args } as Parameters<typeof descriptor.execute>[0]);
  const stopped = assert.rejects(execution);
  await began; const disabled = await setPluginState(plugin.id, { revision: enabled.revision, enabled: false }); await stopped;
  const owned = await requireExtension(plugin.connections[0].id);
  await assert.rejects(() => deleteExtension(owned.id, owned.revision), /插件管理/);
  const chat = await db.chat.create({ data: { title: "Plugin transcript survives", messages: { create: { role: "assistant", content: "historical result" } } } });
  await uninstallPlugin(plugin.id, disabled.revision);
  assert.equal(await db.extension.count({ where: { pluginId: plugin.id } }), 0);
  assert.ok(await db.extension.findUnique({ where: { id: unrelated.id } }));
  assert.equal(await resolveToolDescriptor(entry.id), null);
  assert.equal((await db.message.findFirst({ where: { chatId: chat.id } }))?.content, "historical result");
});

test("manifest validation rejects scripts, credentials, unsupported versions and duplicate declarations", () => {
  const base = pluginFixture();
  for (const input of [{ ...base, scripts: { install: "run" } }, { ...base, schemaVersion: 2 }, { ...base, skills: [base.skills[0], base.skills[0]] }, { ...base, skills: [], connections: [] }, { ...base, skills: [{ ...base.skills[0], instructions: "x".repeat(6001) }] }]) assert.equal(pluginManifestSchema.safeParse(input).success, false);
  const connection = pluginFixture("https://example.com").connections[0];
  assert.equal(pluginManifestSchema.safeParse({ ...base, connections: [{ ...connection, credentials: [{ key: "Authorization", value: "secret" }] }] }).success, false);
  assert.equal(pluginManifestSchema.safeParse({ ...base, connections: [{ ...connection, credentials: [{ key: "Host" }] }] }).success, false);
  for (const preview of pluginCatalog) assert.deepEqual(parsePlugin(preview.manifest), preview);
  for (const name of ["writing", "library-docs"]) assert.ok(parsePlugin(JSON.parse(readFileSync(resolve(`docs/examples/${name}.ria-plugin.json`), "utf8"))).digest);
});

test("uninstall during a pending detection cannot recreate a package or publish its tools", async t => {
  const { plugin, service, connection } = await configured(t);
  service.state.hold = true;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); service.state.onProbe = entered;
  const probe = testExtension(connection.id, connection.revision);
  const stopped = assert.rejects(probe);
  await started; await uninstallPlugin(plugin.id, plugin.revision); await stopped;
  assert.equal(await db.pluginPackage.count(), 0); assert.equal(await db.extension.count(), 0);
  assert.equal(await formatPluginSkills(), "");
});

test("simultaneous installs have one owner and connection limits reject the whole package", async () => {
  const preview = parsePlugin(pluginFixture("https://example.com"));
  const outcomes = await Promise.allSettled([installPlugin(preview), installPlugin(preview)]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(await db.pluginPackage.count(), 1); assert.equal(await db.extension.count(), 1);
  await db.pluginPackage.deleteMany({});
  for (let index = 0; index < 20; index++) await saveExtension({ name: `Connection ${index}`, config: { type: "mcp-http", url: "https://example.com/mcp" } });
  await assert.rejects(() => installPlugin(preview), /20/);
  assert.equal(await db.pluginPackage.count(), 0); assert.equal(await db.extension.count(), 20);
});

test("local-program declarations need a separate consent and never run an installer", async () => {
  const preview = parsePlugin({ ...pluginFixture(), connections: [{ id: "local", name: "Installed program", config: { type: "mcp-stdio", command: process.execPath, args: [], cwd: process.cwd(), processPermission: true } }] });
  await assert.rejects(() => installPlugin(preview), /本地程序权限/);
  assert.equal(await db.extension.count(), 0);
  const installed = await installPlugin({ ...preview, allowLocalProcesses: true });
  assert.equal(installed.enabled, false);
  const bad = parsePlugin({ ...preview.manifest, id: "test.shell", connections: [{ ...preview.manifest.connections[0], config: { type: "mcp-stdio", command: "cmd.exe", args: ["/c", "npm install"], cwd: process.cwd(), processPermission: true } }] });
  await assert.rejects(() => installPlugin({ ...bad, allowLocalProcesses: true }), /Shell|绝对路径/);
  assert.equal(await db.pluginPackage.count(), 1);
});

test("package and active instruction limits remain bounded and failed installation leaves no partial rows", async () => {
  const first = await installPlugin(parsePlugin({ ...pluginFixture(), id: "test.large-first", skills: [{ ...pluginFixture().skills[0], instructions: "a".repeat(6000) }, { ...pluginFixture().skills[0], id: "second", instructions: "b".repeat(6000) }] }));
  const second = await installPlugin(parsePlugin({ ...first.manifest, id: "test.large-second" }));
  const third = await installPlugin(parsePlugin({ ...pluginFixture(), id: "test.third" }));
  await setPluginState(first.id, { revision: 1, enabled: true }); await setPluginState(second.id, { revision: 1, enabled: true });
  await assert.rejects(() => setPluginState(third.id, { revision: 1, enabled: true }), /24000/);
  for (let index = 3; index < 12; index++) await installPlugin(parsePlugin({ ...pluginFixture(), id: `test.limit-${index}` }));
  await assert.rejects(() => installPlugin(parsePlugin({ ...pluginFixture(), id: "test.overflow" })), /12/);
  assert.equal(await db.pluginPackage.count(), 12); assert.equal(await db.extension.count(), 0);
});

test("plugin APIs retain local access, write origin checks, body bounds and optimistic revisions", async () => {
  assert.equal((await routes.GET(request("GET", undefined, ""))).status, 401);
  assert.equal((await routes.POST(request("POST", parsePlugin(pluginFixture()), cookie, { Origin: "https://foreign.invalid" }))).status, 403);
  assert.equal((await previewRoute.POST(request("POST", { padding: "x".repeat(2_097_153) }))).status, 413);
  const created = await routes.POST(request("POST", parsePlugin(pluginFixture()))); assert.equal(created.status, 201);
  const plugin = (await created.json()).data;
  assert.equal((await itemRoute.PATCH(request("PATCH", { revision: 999, enabled: true }), context(plugin.id))).status, 409);
  assert.equal((await itemRoute.PATCH(request("PATCH", { revision: 1, enabled: true }), context(plugin.id))).status, 200);
  assert.equal((await itemRoute.DELETE(new NextRequest(`http://localhost/api/plugins/${plugin.id}?revision=1`, { method: "DELETE", headers: { cookie } }), context(plugin.id))).status, 409);
  const response = await routes.GET(request("GET")); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).data.catalog.length, 3);
});
