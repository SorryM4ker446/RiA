import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { marketSearchItem, marketSnapshot } from "../helpers/skill-marketplace-fixture";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { getSkill, searchSkills } = await import("@/lib/plugins/skill-marketplace");
const { parsePlugin } = await import("@/lib/plugins/schema");
const { installPlugin, setPluginState, uninstallPlugin, formatPluginSkills } = await import("@/lib/plugins/store");
const { readPluginSkill } = await import("@/tools/definitions/plugin-skill");
const { createChatToolSet, executeRegisteredTool } = await import("@/tools/execution");
const { toolAvailability } = await import("@/tools/registry");
const route = await import("@/app/api/plugins/skills/route");
const identity = { repository: "ria-tests/skills", skill: "community-writing" };
let cookie: string;
beforeEach(async (t: TestContext) => {
  process.env.APP_RUNTIME = "test"; cookie = localAccessCookie(); globalThis.__privateAiRateLimitStore?.clear();
  await db.pluginPackage.deleteMany({});
  t.mock.method(console, "error", () => {});
});
after(async () => { await db.$disconnect(); cleanup(); });
const signal = () => new AbortController().signal;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("skill search validates identities, deduplicates and never forwards workspace or connection secrets", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++; assert.equal(url, "https://skills.sh/api/search?q=writing&limit=30");
    assert.deepEqual(options.headers, { Accept: "application/json" }); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
    return response({ skills: [marketSearchItem, marketSearchItem, { ...marketSearchItem, source: "http://127.0.0.1/private" }, { ...marketSearchItem, id: "other/repo/impostor" }, { invalid: true }] });
  });
  const result = await searchSkills({ q: "writing" }, signal());
  assert.equal(result.items.length, 1); assert.equal(result.skipped, 3); assert.equal(calls, 1);
  await assert.rejects(() => searchSkills({ q: "x" }, signal()));
  await assert.rejects(() => searchSkills({ q: "writing", url: "https://private.invalid" }, signal()));
  assert.equal(calls, 1); assert.equal(await db.pluginPackage.count(), 0);
});

test("marketplace snapshots retain full instructions and references, install inactive, and read locally only while enabled", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => { calls++; assert.equal(url, "https://skills.sh/api/download/ria-tests/skills/community-writing"); return response({ ...marketSnapshot(), hash: "a".repeat(64) }); });
  const preview = await getSkill(identity, signal());
  assert.equal(calls, 1); assert.equal(await db.pluginPackage.count(), 0);
  assert.equal(preview.manifest.marketplace.hash, "a".repeat(64));
  assert.ok(preview.manifest.marketplace.files[0].contents.length > 6000);
  assert.equal(preview.manifest.marketplace.files.length, 3);
  assert.match(preview.manifest.description, /Polish writing/);
  const plugin = await installPlugin(preview);
  assert.equal(plugin.enabled, false); assert.equal(plugin.connections.length, 0);
  assert.equal((await toolAvailability("readPluginSkill")).available, false);
  await assert.rejects(() => readPluginSkill.execute({ workspaceId: "local", trigger: "auto", input: { packageId: plugin.packageId, path: "SKILL.md", offset: 0 } }));
  await assert.rejects(() => installPlugin(preview), /已安装/);
  const active = await setPluginState(plugin.id, { revision: 1, enabled: true });
  const guidance = await formatPluginSkills();
  assert.match(guidance, /readPluginSkill/); assert.match(guidance, /whenToUse/); assert.ok(!guidance.includes("SKILL_MARKET_MAIN"));
  const tools = await createChatToolSet({ toolIds: [] });
  assert.ok(tools.readPluginSkill); assert.ok(!tools.writeLocalFile); assert.ok(!tools.webSearch);
  const list = await executeRegisteredTool(readPluginSkill, { packageId: plugin.packageId }, { trigger: "auto" });
  assert.equal(list.output.files.length, 3); assert.equal(list.output.scriptsExecutable, false);
  const main = await executeRegisteredTool(readPluginSkill, { packageId: plugin.packageId, path: "SKILL.md" }, { trigger: "auto" });
  assert.match(main.output.contents, /SKILL_MARKET_MAIN/);
  const first = await executeRegisteredTool(readPluginSkill, { packageId: plugin.packageId, path: "references/style.md" }, { trigger: "auto" });
  assert.equal(first.output.contents.length, 12_000); assert.equal(first.output.nextOffset, 12_000);
  const next = await executeRegisteredTool(readPluginSkill, { packageId: plugin.packageId, path: "references/style.md", offset: first.output.nextOffset }, { trigger: "auto" });
  assert.notEqual(first.output.contents, next.output.contents);
  await assert.rejects(() => executeRegisteredTool(readPluginSkill, { packageId: plugin.packageId, path: "../secret" }, { trigger: "auto" }), /没有此文件/);
  assert.equal(calls, 1);
  const disabled = await setPluginState(plugin.id, { revision: active.revision, enabled: false });
  await assert.rejects(() => executeRegisteredTool(readPluginSkill, { packageId: plugin.packageId, path: "SKILL.md" }, { trigger: "auto" }));
  await uninstallPlugin(plugin.id, disabled.revision); assert.equal(await formatPluginSkills(), "");
});

test("snapshots reject unsafe paths, duplicate files, missing entrypoint, invalid metadata and wrong identities without writes", async t => {
  let data = marketSnapshot();
  t.mock.method(globalThis, "fetch", async () => response(data));
  for (const files of [
    [{ path: "../SKILL.md", contents: "bad" }],
    [...marketSnapshot().files, { path: "skill.md", contents: "duplicate" }],
    [{ path: "references/only.md", contents: "no entrypoint" }],
    [{ path: "SKILL.md", contents: "---\nname: wrong-skill\ndescription: wrong identity\n---\nhello" }],
    [{ path: "SKILL.md", contents: "---\nname: &x sample\ndescription: *x\n---\n" }],
    [{ path: "SKILL.md", contents: "no metadata" }],
    [{ path: "SKILL.md", contents: "---\nname: community-writing\nname: duplicate\ndescription: duplicate\n---\n" }],
    [{ path: "SKILL.md", contents: "binary\0file" }],
  ]) { data = marketSnapshot(files); await assert.rejects(() => getSkill(identity, signal())); }
  assert.equal(await db.pluginPackage.count(), 0);
  data = marketSnapshot(); const good = await getSkill(identity, signal());
  const changed = structuredClone(good.manifest); changed.marketplace.files[0].contents += "tampered";
  assert.throws(() => parsePlugin(changed), /content hash/);
  const altered = structuredClone(good); altered.manifest.description = "changed after preview";
  await assert.rejects(() => installPlugin(altered), /预览/);
});

test("only the official apex-to-www redirect is followed; upstream failures and oversized responses stay actionable", async t => {
  const seen: string[] = []; let location = "https://www.skills.sh/api/search?q=writing&limit=30";
  t.mock.method(globalThis, "fetch", async (url: string) => { seen.push(url); return url.startsWith("https://skills.sh/") ? new Response(null, { status: 308, headers: { location } }) : response({ skills: [] }); });
  assert.equal((await searchSkills({ q: "writing" }, signal())).items.length, 0); assert.equal(seen.length, 2);
  for (const target of ["http://127.0.0.1/private", "https://other.invalid/api/search?q=writing&limit=30", "https://www.skills.sh/api/download/other", "https://user:secret@www.skills.sh/api/search?q=writing&limit=30"]) {
    location = target; const count = seen.length; await assert.rejects(() => searchSkills({ q: "writing" }, signal())); assert.equal(seen.length, count + 1);
  }
  t.mock.restoreAll(); t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  await assert.rejects(() => getSkill(identity, signal()), /暂无可下载/);
  t.mock.restoreAll(); t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(262_145)));
  await assert.rejects(() => searchSkills({ q: "writing" }, signal()), /超过/);
  t.mock.restoreAll(); t.mock.method(globalThis, "fetch", async () => response({ skills: "invalid" }));
  await assert.rejects(() => searchSkills({ q: "writing" }, signal()), /暂时不可用/);
});

test("cancelling a response body closes the reader and prevents stale details from completing", async t => {
  let cancelled = false; let started: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"files":[')); started(); }, cancel() { cancelled = true; } })));
  const controller = new AbortController(); const pending = getSkill(identity, controller.signal);
  await reading; controller.abort(new Error("Replaced skill"));
  await assert.rejects(() => pending, /Replaced skill/); assert.equal(cancelled, true); assert.equal(await db.pluginPackage.count(), 0);
});

test("Skill marketplace API requires local access, validates query boundaries and makes no installation writes", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response({ skills: [marketSearchItem] }); });
  const req = (query: string, auth = cookie) => new NextRequest(`http://localhost/api/plugins/skills?${query}`, { headers: auth ? { cookie: auth } : {} });
  assert.equal((await route.GET(req("q=writing", ""))).status, 401);
  assert.equal((await route.GET(req("q=writing&q=react"))).status, 400);
  assert.equal((await route.GET(req("q=x"))).status, 400);
  assert.equal((await route.GET(req("repository=http://127.0.0.1&skill=writing"))).status, 400);
  assert.equal(calls, 0);
  const good = await route.GET(req("q=writing")); assert.equal(good.status, 200); assert.equal(good.headers.get("cache-control"), "no-store");
  assert.equal((await good.json()).data.items.length, 1); assert.equal(calls, 1); assert.equal(await db.pluginPackage.count(), 0);
});
