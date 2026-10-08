import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { fixtureLibraryItem } from "../helpers/model-fixture";
import { languageModel, providerState, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase(); process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { indexDocument } = await import("@/lib/documents/store");
const { indexDocumentEmbeddings } = await import("@/lib/documents/semantic");
const { retrieveDocuments } = await import("@/lib/documents/retrieval");
const { defaultRetrievalPolicy } = await import("@/lib/assistants/schema");
const { evaluateDocuments, evaluationRequestSchema } = await import("@/lib/documents/evaluation");
const { documentSourceUrl } = await import("@/lib/documents/types");
const { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const route = await import("@/app/api/documents/evaluate/route");
const modelRef = { providerId: "openrouter", modelId: "openai/text-embedding-3-small" } as const;
let cookie: string;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "warn", () => {}); resetProviderState(); globalThis.__privateAiRateLimitStore?.clear(); cookie = localAccessCookie();
  await db.chat.deleteMany({}); await db.knowledgeDocument.deleteMany({}); await db.workspacePreference.deleteMany({});
  const prefs = await seedTestModelPreferences(db); prefs.embedding = modelRef; prefs.library = [...prefs.library, { ...fixtureLibraryItem(modelRef.modelId, ["embedding"]), providerId: "openrouter" }];
  await db.workspacePreference.update({ where: { id: "local" }, data: { settings: prefs } }); process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  providerState.embeddingFunction = text => /公务出行|费用核销|出门办事/u.test(text) ? [1, 0, 0] : [0, 1, 0];
});
after(async () => { await db.$disconnect(); cleanup(); });
async function document(text: string, filename = "差旅规程.md", collection = "财务") {
  return (await indexDocument({ filename, collection, format: "md", byteSize: Buffer.byteLength(text), pages: [{ pageNumber: null, text }] })).document;
}
const request = (body: unknown, auth = cookie) => new NextRequest("http://localhost/api/documents/evaluate", { method: "POST", headers: { cookie: auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("retrieval diagnoses empty ranges, absent indices and model outages without hiding lexical fallback", async () => {
  const emptyLibrary = await retrieveDocuments("费用核销");
  assert.equal(emptyLibrary.diagnostics.outcome, "empty-library"); assert.equal(emptyLibrary.diagnostics.semantic, "not-run");
  const doc = await document("公务出行的费用核销应在十个工作日内提交。");
  const unindexed = await retrieveDocuments("费用核销"); assert.equal(unindexed.diagnostics.semantic, "unindexed"); assert.equal(unindexed.sources.length, 1);
  await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  const ready = await retrieveDocuments("出门办事的钱怎样领回来"); assert.equal(ready.diagnostics.semantic, "ready"); assert.equal(ready.diagnostics.semanticCandidates, 1); assert.equal(ready.diagnostics.scannedVectors, 1);
  providerState.embeddingError = true;
  const failed = await retrieveDocuments("费用核销"); assert.equal(failed.diagnostics.semantic, "failed"); assert.ok(failed.sources.length); assert.equal(failed.sources[0].retrieval, "local-keyword");
  const empty = await retrieveDocuments("费用核销", 8, ["未知集合"]); assert.equal(empty.diagnostics.outcome, "empty-library"); assert.deepEqual(empty.sources, []);
});

test("thresholds filter semantic evidence and evidence budgets preserve complete versioned excerpts", async () => {
  const doc = await document(Array.from({ length: 8 }, (_, i) => `公务出行费用核销条款 ${i}：${"必须保留真实票据并经主管审批，".repeat(40)}`).join("\n\n"));
  await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  providerState.embeddingFunction = () => [0.4, Math.sqrt(0.84), 0];
  const accepted = await retrieveDocuments("出门办事的钱怎样领回来", 8, [], undefined, { ...defaultRetrievalPolicy, semanticThreshold: 0.35, contextChars: 1200 });
  assert.ok(accepted.sources.length); assert.ok(accepted.diagnostics.contextChars <= 1200);
  const original = await db.documentChunk.findMany({ where: { documentId: doc.id } });
  assert.ok(accepted.sources.every(source => original.some(chunk => chunk.id === source.chunkId && chunk.text === source.snippet)));
  const excluded = await retrieveDocuments("出门办事的钱怎样领回来", 8, [], undefined, { ...defaultRetrievalPolicy, semanticThreshold: 0.5 });
  assert.deepEqual(excluded.sources, []);
});

test("similar clauses with conflicting quantities in the same document are retained as distinct evidence", async () => {
  const prefix = "公务出行费用核销需要保留税务票据，填写真实费用清单，由部门主管核对相关凭证并签字审批，归档后向财务部门提交。";
  await document(`${prefix} 提交时限为十个工作日。\n\n${prefix} 提交时限为二十个工作日。`);
  const result = await retrieveDocuments("费用核销时限", 2);
  assert.equal(result.sources.length, 2); assert.ok(result.sources.some(source => source.snippet.includes("为十个"))); assert.ok(result.sources.some(source => source.snippet.includes("为二十个")));
});

test("diagnostic metadata remains available when a turn has no source snippets", async () => {
  const diagnostics = (await retrieveDocuments("无资料问题")).diagnostics;
  const content = encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "证据不足", tools: [], documentDiagnostics: diagnostics });
  assert.deepEqual(decodePersistedAssistantToolMessage(content)?.documentDiagnostics, diagnostics);
  const ui = mapStoredMessagesToUI([{ id: "answer", role: "assistant", clientMessageId: null, content }]);
  assert.deepEqual((ui.uiMessages[0].metadata as { documentDiagnostics: unknown }).documentDiagnostics, diagnostics);
});

test("retrieval diagnostics expose mismatched vector dimensions instead of silently counting them as usable evidence", async () => {
  const doc = await document("公务出行费用核销应保留票据。"); await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  providerState.embeddingFunction = () => [1, 0];
  const result = await retrieveDocuments("出门办事的钱怎样领回来");
  assert.equal(result.diagnostics.invalidVectors, 1); assert.equal(result.diagnostics.scannedVectors, 1); assert.deepEqual(result.sources, []);
});

test("evaluation measures real retrieved facts while keeping expected answers out of model prompts", async t => {
  await document("费用核销须在十个工作日内提交，逾期需要主管书面说明。");
  const result = await retrieveDocuments("费用核销"); const url = documentSourceUrl(result.sources[0]);
  const original = languageModel.doGenerate.bind(languageModel);
  const prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => {
    prompts.push(JSON.stringify(options.prompt));
    const response = await original(options);
    return { ...response, content: [{ type: "text", text: `十个工作日内提交，逾期需要书面说明。[差旅规程.md](${url}) [虚构](/knowledge/documents/unknown#unknown)` }] };
  });
  const input = evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, cases: [{ question: "费用核销怎么办", expectedFilenames: ["差旅规程.md"], requiredFacts: ["十个工作日", "书面说明", "SCORER_ONLY_SENTINEL"] }] });
  const report = await evaluateDocuments(input, new AbortController().signal);
  assert.equal(report.cases[0].documentRecall, 1); assert.equal(report.cases[0].evidenceFactCoverage, 2 / 3); assert.equal(report.cases[0].answerFactCoverage, 2 / 3);
  assert.equal(report.cases[0].citedSources, 1); assert.deepEqual(report.cases[0].unknownCitations, ["/knowledge/documents/unknown#unknown"]);
  assert.doesNotMatch(prompts.join("\n"), /SCORER_ONLY_SENTINEL/);
});

test("evaluation reports per-question generation failures, empty expectations and unexpected evidence honestly", async t => {
  await document("费用核销须在十个工作日内提交。");
  t.mock.method(languageModel, "doGenerate", async () => { throw new Error("Synthetic outage"); });
  const report = await evaluateDocuments(evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, cases: [{ question: "费用核销", answerable: false }] }), new AbortController().signal);
  const row = report.cases[0]; assert.equal(row.status, "failed"); assert.equal(row.unexpectedEvidence, true); assert.equal(row.answer, null); assert.equal(row.documentRecall, null); assert.equal(row.answerFactCoverage, null); assert.ok(row.sources.length);
});

test("evaluation requires explicit confirmation, authentication and bounded cases before making calls", async () => {
  const body = { confirm: true, cases: [{ question: "问题" }] };
  assert.equal((await route.POST(request(body, ""))).status, 401);
  assert.equal((await route.POST(request({ ...body, confirm: false }))).status, 400);
  assert.equal((await route.POST(request({ ...body, cases: Array.from({ length: 13 }, () => ({ question: "问题" })) }))).status, 400);
  assert.equal(providerState.embeddingCalls.length, 0);
  globalThis.__privateAiRateLimitStore?.clear();
  assert.equal((await route.POST(request(body))).status, 200);
  assert.equal((await route.POST(request(body))).status, 200);
  assert.equal((await route.POST(request(body))).status, 429);
});

test("cancelled evaluations cannot continue to model calls or return a successful report", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateDocuments(evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, cases: [{ question: "问题" }] }), controller.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(providerState.embeddingCalls.length, 0);
});
