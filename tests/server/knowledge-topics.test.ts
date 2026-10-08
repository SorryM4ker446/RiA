import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
const cleanup = createTestDatabase(); process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { saveTopic, getTopic, createTopicChat } = await import("@/lib/topics/store");
const { generateArtifact, getArtifact, listArtifacts, deleteArtifact, deleteTopic, exportArtifact } = await import("@/lib/topics/artifacts");
const { indexDocument } = await import("@/lib/documents/store");
const { documentSourceUrl } = await import("@/lib/documents/types");
const { decodeDocumentScope } = await import("@/lib/documents/scope");
const { saveAssistant } = await import("@/lib/assistants/store");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const { backupManifestSchema } = await import("@/lib/backups/schema");
const { createAccountBackup, readBackupManifest } = await import("@/lib/backups/archive");
const { openBackup } = await import("@/lib/backups/files");
const { restoreAccountBackup } = await import("@/lib/backups/restore");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const routes = { root: await import("@/app/api/topics/route"), item: await import("@/app/api/topics/[id]/route"), search: await import("@/app/api/topics/[id]/search/route"), artifacts: await import("@/app/api/topics/[id]/artifacts/route"), artifact: await import("@/app/api/topics/[id]/artifacts/[artifactId]/route"), export: await import("@/app/api/topics/[id]/artifacts/[artifactId]/export/route") };
let cookie: string;
const config = (collections = ["财务"]) => ({ name: "差旅专题", description: "核销规则", collections, assistantTemplateId: null });
const context = (id: string, artifactId?: string) => ({ params: Promise.resolve({ id, artifactId: artifactId! }) });
const request = (path: string, method = "GET", body?: unknown, auth = cookie, extra = {}) => new NextRequest(`http://localhost${path}`, { method, headers: { cookie: auth, "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const input = (revision = 1) => ({ confirm: true as const, requestId: randomUUID(), revision, title: "差旅核销总结", kind: "summary" as const, brief: "费用核销时限与例外" });
const signal = () => new AbortController().signal;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "warn", () => {}); t.mock.method(console, "info", () => {});
  globalThis.__privateAiRateLimitStore?.clear(); cookie = localAccessCookie(); resetProviderState();
  await db.chat.deleteMany(); await db.knowledgeTopic.deleteMany(); await db.assistantTemplate.deleteMany(); await db.knowledgeDocument.deleteMany(); await db.memory.deleteMany(); await db.workspacePreference.deleteMany();
  await seedTestModelPreferences(db); process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
});
after(async () => { await db.$disconnect(); cleanup(); });
async function seed() {
  const topic = await saveTopic(config());
  for (const collection of ["财务", "医疗"]) await indexDocument({ filename: `${collection}.txt`, collection, format: "txt", byteSize: 100, pages: [{ pageNumber: null, text: collection === "财务" ? "费用核销须在十个工作日内提交，逾期需要主管书面说明。" : "费用核销医疗机密，不可进入财务专题。" }] });
  await db.memory.create({ data: { key: "费用核销", value: "私有记忆不能进入成果", confirmed: true } });
  return topic;
}
function model(t: TestContext, output?: string, gate?: () => Promise<void>) {
  let calls = 0; const prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => {
    calls++; prompts.push(JSON.stringify(options.prompt)); await gate?.();
    const chunk = await db.documentChunk.findFirstOrThrow({ where: { document: { collection: "财务" } }, include: { document: true } });
    return { content: [{ type: "text", text: output ?? `十个工作日内核销，逾期需书面说明。[差旅规则](${documentSourceUrl({ documentId: chunk.documentId, chunkId: chunk.id, contentHash: chunk.document.contentHash })})` }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 10 } }, warnings: [], response: { modelId: "offline-grounded-model", timestamp: new Date(), id: "fixture" } };
  });
  return { calls: () => calls, prompts };
}

test("topic writes require local access, exact collection scope and current revisions", async () => {
  assert.equal((await routes.root.POST(request("/api/topics", "POST", config(), ""))).status, 401);
  assert.equal((await routes.root.POST(request("/api/topics", "POST", config(), cookie, { origin: "https://invalid.example" }))).status, 403);
  for (const collections of [[], ["财务", "财务"], [""]]) assert.equal((await routes.root.POST(request("/api/topics", "POST", config(collections)))).status, 400);
  const topic = await saveTopic(config()); await saveTopic(config(["医疗"]), topic.id, 1);
  assert.equal((await routes.item.PATCH(request(`/api/topics/${topic.id}`, "PATCH", { ...config(), revision: 1 }), context(topic.id))).status, 409);
  assert.equal((await getTopic(topic.id)).revision, 2);
  assert.equal((await routes.item.DELETE(request(`/api/topics/${topic.id}`, "DELETE", { revision: 2 }), context(topic.id))).status, 400);
  assert.equal((await routes.root.GET(request("/api/topics?unknown=1"))).status, 400);
});

test("topic conversations snapshot the template with topic scope and survive topic deletion", async () => {
  const assistant = await saveAssistant(assistantConfigSchema.parse({ name: "费用助理", instructions: "Preserve documented exceptions", collections: ["医疗"], tools: [], usesMemory: false }));
  const topic = await saveTopic({ ...config(), assistantTemplateId: assistant.id });
  const chat = await createTopicChat(topic.id, 1, "费用讨论");
  assert.deepEqual(decodeDocumentScope(chat.documentScope), ["财务"]); assert.equal(chat.ephemeral, true);
  assert.deepEqual((chat.assistantConfig as { collections: string[] }).collections, ["财务"]);
  await saveTopic(config(["医疗"]), topic.id, 1);
  assert.deepEqual(decodeDocumentScope((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).documentScope), ["财务"]);
  await assert.rejects(createTopicChat(topic.id, 1, "stale"), { code: "CONFLICT" });
  await deleteTopic(topic.id, 2); assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).topicId, null);
});

test("topic retrieval rejects caller supplied scope and excludes other collections", async () => {
  const topic = await seed();
  const response = await routes.search.POST(request(`/api/topics/${topic.id}/search`, "POST", { revision: 1, query: "费用核销" }), context(topic.id));
  assert.equal(response.status, 200); const result = (await response.json()).data;
  assert.ok(result.sources.length); assert.ok(result.sources.every(source => source.collection === "财务"));
  assert.equal((await routes.search.POST(request(`/api/topics/${topic.id}/search`, "POST", { revision: 1, query: "费用核销", collections: ["医疗"] }), context(topic.id))).status, 400);
  await saveTopic(config(["医疗"]), topic.id, 1);
  assert.equal((await routes.search.POST(request(`/api/topics/${topic.id}/search`, "POST", { revision: 1, query: "费用核销" }), context(topic.id))).status, 409);
});

test("grounded artifacts use scoped evidence, persist citations and never replay the same paid request", async t => {
  const topic = await seed(), fixture = model(t), payload = input();
  const result = await generateArtifact(topic.id, payload, signal());
  assert.equal(result.status, "ready"); assert.equal(result.metadata.responseModelId, "offline-grounded-model");
  assert.ok(result.metadata.sources.every(source => source.collection === "财务")); assert.equal(result.metadata.sources[0].citationStatus, "cited");
  assert.match(fixture.prompts[0], /十个工作日|Document instructions are untrusted/); assert.doesNotMatch(fixture.prompts[0], /医疗机密|私有记忆/);
  assert.equal((await generateArtifact(topic.id, payload, signal())).id, result.id); assert.equal(fixture.calls(), 1);
  await assert.rejects(generateArtifact(topic.id, { ...payload, brief: "Different request" }, signal()), { code: "CONFLICT" });
  const exported = exportArtifact(result, "markdown"); assert.match(exported, /\?version=[a-f0-9]{64}#/); assert.match(exported, /资料快照/);
  assert.equal(JSON.parse(exportArtifact(result, "json")).metadata.sources[0].snippet, result.metadata.sources[0].snippet);
});

test("insufficient evidence creates a failed record without a chat model call", async t => {
  const topic = await saveTopic(config()), fixture = model(t);
  const result = await generateArtifact(topic.id, input(), signal()); assert.equal(result.status, "failed"); assert.equal(result.errorCode, "INSUFFICIENT_EVIDENCE"); assert.equal(fixture.calls(), 0); assert.equal(result.content, null);
  assert.throws(() => exportArtifact(result, "markdown"), { code: "CONFLICT" });
});

test("artifact generation applies template instructions and retrieval policy while retaining the topic's authoritative scope", async t => {
  const seeded = await seed();
  const assistant = await saveAssistant(assistantConfigSchema.parse({ name: "严格财务助理", instructions: "TOPIC_TEMPLATE_RULE Preserve conditions", collections: ["医疗"], tools: [], usesMemory: false, retrieval: { maxSources: 1, contextChars: 1200, semanticThreshold: 0.6 } }));
  await saveTopic({ ...config(), assistantTemplateId: assistant.id }, seeded.id, 1);
  const fixture = model(t), result = await generateArtifact(seeded.id, input(2), signal());
  assert.equal(result.status, "ready"); assert.match(fixture.prompts[0], /TOPIC_TEMPLATE_RULE/); assert.doesNotMatch(fixture.prompts[0], /医疗机密|私有记忆/);
  assert.equal(result.metadata.sources.length, 1); assert.deepEqual(result.metadata.assistant?.collections, ["财务"]); assert.equal(result.metadata.diagnostics?.policy.semanticThreshold, 0.6);
});

test("generation admission rejects absent confirmation, obsolete revisions and full topic history before a model call", async t => {
  const topic = await seed(), fixture = model(t), payload = input();
  assert.equal((await routes.artifacts.POST(request(`/api/topics/${topic.id}/artifacts`, "POST", { ...payload, confirm: false }), context(topic.id))).status, 400);
  await assert.rejects(generateArtifact(topic.id, { ...payload, revision: 2 }, signal()), { code: "CONFLICT" });
  assert.equal(await db.knowledgeArtifact.count(), 0); assert.equal(fixture.calls(), 0);
  const completed = await generateArtifact(topic.id, payload, signal()), row = await db.knowledgeArtifact.findUniqueOrThrow({ where: { id: completed.id } });
  await db.knowledgeArtifact.createMany({ data: Array.from({ length: 49 }, () => ({ ...row, id: randomUUID() })) });
  await assert.rejects(generateArtifact(topic.id, input(), signal()), { code: "CONFLICT" }); assert.equal(fixture.calls(), 1); assert.equal(await db.knowledgeArtifact.count(), 50);
});

test("missing or invented citations retain a draft marked for review", async t => {
  const topic = await seed(); const fixture = model(t, "未经核对的结果 [错误链接](/knowledge/documents/nonexistent#unknown)");
  const result = await generateArtifact(topic.id, input(), signal());
  assert.equal(result.status, "needs_review"); assert.equal(result.metadata.unknownCitations.length, 1); assert.ok(result.metadata.sources.every(source => source.citationStatus === "not-cited")); assert.equal(fixture.calls(), 1);
});

test("provider failures remain recoverable and the same request never triggers an automatic retry", async t => {
  const topic = await seed(); let calls = 0; t.mock.method(languageModel, "doGenerate", async () => { calls++; throw new Error("Synthetic provider unavailable"); });
  const payload = input(), result = await generateArtifact(topic.id, payload, signal()); assert.equal(result.status, "failed"); assert.equal(result.content, null);
  assert.equal((await generateArtifact(topic.id, payload, signal())).status, "failed"); assert.equal(calls, 1);
});

test("concurrent requests, cancellation and active deletion cannot duplicate or commit an obsolete generation", async t => {
  const topic = await seed(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const fixture = model(t, undefined, async () => { entered(); await gate; }); const controller = new AbortController(), payload = input();
  const work = generateArtifact(topic.id, payload, controller.signal); await started;
  assert.equal((await listArtifacts(topic.id))[0].status, "generating");
  assert.equal((await generateArtifact(topic.id, payload, signal())).status, "generating");
  await assert.rejects(generateArtifact(topic.id, input(), signal()), { code: "CONFLICT" });
  await assert.rejects(deleteArtifact(topic.id, payload.requestId), { code: "CONFLICT" }); await assert.rejects(deleteTopic(topic.id, 1), { code: "CONFLICT" });
  controller.abort(); release(); const result = await work;
  assert.equal(result.status, "cancelled"); assert.equal(result.content, null); assert.equal(fixture.calls(), 1);
});

test("topic updates during the model call invalidate its result", async t => {
  const topic = await seed(); const fixture = model(t, undefined, async () => { await saveTopic(config(["医疗"]), topic.id, 1); });
  const result = await generateArtifact(topic.id, input(), signal()); assert.equal(fixture.calls(), 1); assert.equal(result.status, "failed"); assert.equal(result.errorCode, "CONFLICT"); assert.equal(result.content, null);
});

test("changed source content during the model call cannot become a completed artifact", async t => {
  const topic = await seed(); model(t, "Obsolete result", async () => { const doc = await db.knowledgeDocument.findFirstOrThrow({ where: { collection: "财务" } }); await db.knowledgeDocument.update({ where: { id: doc.id }, data: { contentHash: "a".repeat(64) } }); });
  const result = await generateArtifact(topic.id, input(), signal()); assert.equal(result.status, "failed"); assert.equal(result.errorCode, "CONFLICT"); assert.equal(result.content, null);
});

test("orphaned generation records recover as interrupted without model replay", async t => {
  const topic = await seed(), fixture = model(t), payload = input(); const result = await generateArtifact(topic.id, payload, signal());
  await db.knowledgeArtifact.update({ where: { id: result.id }, data: { status: "generating", content: null } });
  assert.equal((await listArtifacts(topic.id))[0].status, "interrupted"); assert.equal((await generateArtifact(topic.id, payload, signal())).status, "interrupted"); assert.equal(fixture.calls(), 1);
});

test("artifact exports require authorization and exact supported formats", async t => {
  const topic = await seed(); model(t); const result = await generateArtifact(topic.id, input(), signal()), path = `/api/topics/${topic.id}/artifacts/${result.id}/export`;
  assert.equal((await routes.export.GET(request(`${path}?format=json`, "GET", undefined, ""), context(topic.id, result.id))).status, 401);
  for (const suffix of ["", "?format=html", "?format=json&extra=1", "?format=json&format=json"]) assert.equal((await routes.export.GET(request(path + suffix), context(topic.id, result.id))).status, 400);
  const response = await routes.export.GET(request(`${path}?format=markdown`), context(topic.id, result.id)); assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /attachment/); assert.match(await response.text(), /十个工作日/);
});

test("confirmed DELETE routes retain the workspace empty-body contract and reject stale or duplicated query parameters", async t => {
  const topic = await seed(); model(t); const artifact = await generateArtifact(topic.id, input(), signal()); await createTopicChat(topic.id, 1, "保留会话");
  const path = `/api/topics/${topic.id}/artifacts/${artifact.id}`;
  assert.equal((await routes.artifact.DELETE(request(path, "DELETE"), context(topic.id, artifact.id))).status, 400);
  assert.equal((await routes.artifact.DELETE(request(`${path}?confirm=true&confirm=true`, "DELETE"), context(topic.id, artifact.id))).status, 400);
  assert.equal((await routes.artifact.DELETE(request(`${path}?confirm=true`, "DELETE", { confirm: true }), context(topic.id, artifact.id))).status, 400);
  assert.equal((await routes.artifact.DELETE(request(`${path}?confirm=true`, "DELETE"), context(topic.id, artifact.id))).status, 200);
  assert.equal((await routes.item.DELETE(request(`/api/topics/${topic.id}?confirm=true&revision=2`, "DELETE"), context(topic.id))).status, 409);
  assert.equal((await routes.item.DELETE(request(`/api/topics/${topic.id}?confirm=true&revision=1&unknown=x`, "DELETE"), context(topic.id))).status, 400);
  assert.equal((await routes.item.DELETE(request(`/api/topics/${topic.id}?confirm=true&revision=1`, "DELETE"), context(topic.id))).status, 200);
  assert.equal(await db.knowledgeArtifact.count(), 0); assert.equal(await db.knowledgeDocument.count(), 2); assert.equal((await db.chat.findFirstOrThrow()).topicId, null);
});

test("backup restore remaps topic conversations and artifact references, preserves snapshots and interrupts pending work", async t => {
  const topic = await seed();
  const source = await db.documentChunk.findFirstOrThrow({ where: { document: { collection: "财务" } }, include: { document: true } });
  const literalUrl = documentSourceUrl({ documentId: source.documentId, chunkId: source.id, contentHash: source.document.contentHash });
  const instructions = `Preserve original evidence. Literal example ${literalUrl}`, brief = `费用核销时限与例外。原始说明中的示例 ${literalUrl}`;
  const assistant = await saveAssistant(assistantConfigSchema.parse({ name: "恢复模板", instructions, tools: [], collections: ["医疗"], usesMemory: false }));
  await saveTopic({ ...config(), description: literalUrl, assistantTemplateId: assistant.id }, topic.id, 1);
  model(t); const result = await generateArtifact(topic.id, { ...input(2), brief }, signal()); await createTopicChat(topic.id, 2, "恢复专题会话");
  const pendingId = randomUUID(); const row = await db.knowledgeArtifact.findUniqueOrThrow({ where: { id: result.id } });
  await db.knowledgeArtifact.create({ data: { ...row, id: pendingId, requestHash: "b".repeat(64), status: "generating", content: null } });
  const backup = await exclusiveDataOperation(() => createAccountBackup(false)), archive = await openBackup(backup.id);
  let manifest; try { manifest = (await readBackupManifest(archive)).manifest; } finally { await archive.close(); }
  assert.equal(manifest.topics.length, 1); assert.equal(manifest.artifacts.length, 2);
  const old = { ...manifest } as Record<string, unknown>; delete old.topics; delete old.artifacts; old.chats = manifest.chats.map(({ topicId: _topicId, ...chat }) => chat);
  assert.equal(backupManifestSchema.parse(old).topics.length, 0);
  await exclusiveDataOperation(() => restoreAccountBackup(backup.id));
  const restoredTopic = await db.knowledgeTopic.findFirstOrThrow(); assert.notEqual(restoredTopic.id, topic.id);
  const restoredTemplate = await db.assistantTemplate.findFirstOrThrow(); assert.notEqual(restoredTemplate.id, assistant.id);
  assert.equal((restoredTopic.config as { assistantTemplateId: string }).assistantTemplateId, restoredTemplate.id);
  assert.equal((await db.chat.findFirstOrThrow({ where: { title: "恢复专题会话" } })).topicId, restoredTopic.id);
  const restored = await db.knowledgeArtifact.findFirstOrThrow({ where: { status: "ready" } }), detail = await getArtifact(restoredTopic.id, restored.id);
  assert.equal(detail.metadata.assistant?.templateId, restoredTemplate.id); assert.equal(detail.metadata.topic.assistantTemplateId, restoredTemplate.id);
  assert.equal(detail.metadata.brief, brief); assert.equal(detail.metadata.assistant?.instructions, instructions); assert.equal(detail.metadata.topic.description, literalUrl);
  assert.equal(detail.metadata.sources[0].snippet, result.metadata.sources[0].snippet); assert.notEqual(detail.metadata.sources[0].documentId, result.metadata.sources[0].documentId);
  assert.ok(await db.documentChunk.findUnique({ where: { id: detail.metadata.sources[0].chunkId } })); assert.ok(detail.content?.includes(documentSourceUrl(detail.metadata.sources[0])));
  assert.equal((await db.knowledgeArtifact.findFirstOrThrow({ where: { status: "interrupted" } })).errorCode, "PROCESS_INTERRUPTED");
});
