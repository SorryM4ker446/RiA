import assert from "node:assert/strict";
import { after, beforeEach, test, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { fixtureLibraryItem } from "../helpers/model-fixture";
import { languageModel, providerState, resetProviderState } from "../helpers/model-provider";
import qualityCorpus from "../fixtures/document-quality-evaluation.json" with { type: "json" };

const cleanup = createTestDatabase(); process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { indexDocument } = await import("@/lib/documents/store");
const { indexDocumentEmbeddings } = await import("@/lib/documents/semantic");
const { retrieveDocuments } = await import("@/lib/documents/retrieval");
const { defaultRetrievalPolicy } = await import("@/lib/assistants/schema");
const { documentDiagnosticsSchema } = await import("@/lib/documents/diagnostics");
const { evaluateDocuments, evaluationRequestSchema } = await import("@/lib/documents/evaluation");
const { qualityCriteria, validateQualityOutput } = await import("@/lib/documents/quality");
const { documentSourceUrl } = await import("@/lib/documents/types");
const { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const route = await import("@/app/api/documents/evaluate/route");
const modelRef = { providerId: "openrouter", modelId: "openai/text-embedding-3-small" } as const;
let cookie: string;
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "warn", () => {}); resetProviderState(); globalThis.__riaRateLimitStore?.clear(); cookie = localAccessCookie();
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

test("a model whose similarities run low still finds its closest passages, and budgets keep excerpts whole", async () => {
  const doc = await document(Array.from({ length: 8 }, (_, i) => `公务出行费用核销条款 ${i}：${"必须保留真实票据并经主管审批，".repeat(40)}`).join("\n\n"));
  await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  // Shares no word with the passages and is only 0.2 similar: below the fixed 0.35 there used to be.
  providerState.embeddingFunction = () => [0.2, Math.sqrt(0.96), 0];
  const found = await retrieveDocuments("出门办事的钱怎样领回来", 8, [], undefined, { ...defaultRetrievalPolicy, contextChars: 1200 });
  assert.ok(found.sources.length); assert.equal(found.sources[0].retrieval, "semantic"); assert.ok(found.diagnostics.contextChars <= 1200);
  assert.equal("semanticThreshold" in found.diagnostics.policy, false);
  const original = await db.documentChunk.findMany({ where: { documentId: doc.id } });
  assert.ok(found.sources.every(source => original.some(chunk => chunk.id === source.chunkId && chunk.text === source.snippet)));
  // A vector pointing away is no evidence at all.
  providerState.embeddingFunction = () => [-1, 0, 0];
  assert.deepEqual((await retrieveDocuments("出门办事的钱怎样领回来")).sources, []);
});

test("diagnostics saved with the old fixed threshold still read", () => {
  const saved = { outcome: "hits", semantic: "ready", corpusChunks: 1, compatibleVectors: 1, scannedVectors: 1, staleVectors: 0, lexicalCandidates: 0, semanticCandidates: 1, selectedSources: 1, contextChars: 10, durationMs: 1, policy: { semanticThreshold: 0.35, maxSources: 8, contextChars: 8000 } };
  assert.equal(documentDiagnosticsSchema.safeParse(saved).success, true);
});

test("similar clauses with conflicting quantities in the same document are retained as distinct evidence", async () => {
  const prefix = "公务出行费用核销需要保留税务票据，填写真实费用清单，由部门主管核对相关凭证并签字审批，归档后向财务部门提交。";
  await document(`# 甲\n\n${prefix} 提交时限为十个工作日。\n\n# 乙\n\n${prefix} 提交时限为二十个工作日。`);
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
  globalThis.__riaRateLimitStore?.clear();
  assert.equal((await route.POST(request(body))).status, 200);
  assert.equal((await route.POST(request(body))).status, 200);
  assert.equal((await route.POST(request(body))).status, 429);
});

test("cancelled evaluations cannot continue to model calls or return a successful report", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateDocuments(evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, cases: [{ question: "问题" }] }), controller.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(providerState.embeddingCalls.length, 0);
});

test("semantic review detects negated facts without leaking scoring criteria into the generated answer", async t => {
  await document("费用核销须在十个工作日内提交，逾期需要主管书面说明。");
  const url = documentSourceUrl((await retrieveDocuments("费用核销期限")).sources[0]);
  const original = languageModel.doGenerate.bind(languageModel);
  const prompts: string[] = [];
  t.mock.method(languageModel, "doGenerate", async options => {
    prompts.push(JSON.stringify(options.prompt));
    const response = await original(options);
    if (prompts.length === 1) return { ...response, content: [{ type: "text", text: `费用核销不需要在十个工作日内提交。[差旅规程](${url})` }] };
    const payload = JSON.parse((options.prompt.at(-1).content as Array<{ text: string }>)[0].text);
    return { ...response, content: [{ type: "text", text: JSON.stringify({ checks: payload.criteria.map(criterion => ({
      id: criterion.id, verdict: "fail", reason: "结论否定了资料规定或缺少必要说明。", answerQuote: payload.answer,
      evidence: [{ chunkId: payload.sources[0].chunkId, quote: "费用核销须在十个工作日内提交" }],
    })) }) }] };
  });
  const input = evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, judgeAnswers: true, cases: [{ question: "费用核销期限", requiredFacts: ["十个工作日"], expectations: [{ kind: "condition", statement: "SCORER_ONLY_CONDITION" }] }] });
  const report = await evaluateDocuments(input, new AbortController().signal);
  assert.equal(report.cases[0].answerFactCoverage, 1);
  assert.equal(report.cases[0].citedSources, 1);
  assert.equal(report.cases[0].quality.status, "complete");
  assert.equal(report.cases[0].quality.checks.find(check => check.id === "fact-1").verdict, "fail");
  assert.doesNotMatch(prompts[0], /SCORER_ONLY_CONDITION/); assert.match(prompts[1], /SCORER_ONLY_CONDITION/);
  assert.equal(prompts.length, 2); assert.equal(report.judgedAnswers, true);
});

test("review failures retain generated answers, evidence and literal metrics without inventing a quality result", async t => {
  await document("费用核销应保留票据。");
  const original = languageModel.doGenerate.bind(languageModel);
  let calls = 0;
  t.mock.method(languageModel, "doGenerate", async options => {
    const response = await original(options); calls++;
    return { ...response, content: [{ type: "text", text: calls === 1 ? "费用核销应保留票据。" : '{"checks":[]}' }] };
  });
  const report = await evaluateDocuments(evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, judgeAnswers: true, cases: [{ question: "费用核销", requiredFacts: ["票据"] }] }), new AbortController().signal);
  const row = report.cases[0]; assert.equal(row.status, "success"); assert.ok(row.sources.length); assert.equal(row.answerFactCoverage, 1);
  assert.equal(row.quality.status, "failed"); assert.equal(row.quality.errorCode, "UPSTREAM_FAILED"); assert.deepEqual(row.quality.checks, []);
});

test("quality output rejects invented quotations, duplicate or missing checks and unsupported passes", async () => {
  await document("费用核销应保留票据。");
  const sources = (await retrieveDocuments("费用核销")).sources;
  const criteria = qualityCriteria({ answerable: true, requiredFacts: ["票据"], expectations: [] });
  const answer = "应保留票据。";
  const checks = criteria.map(criterion => ({ id: criterion.id, verdict: "pass", reason: "符合证据。", answerQuote: answer, evidence: [{ chunkId: sources[0].chunkId, quote: "应保留票据" }] }));
  assert.equal(validateQualityOutput(JSON.stringify({ checks }), criteria, answer, sources).length, 4);
  for (const invalid of [
    checks.slice(1), [...checks, checks[0]],
    checks.map((check, i) => i === 0 ? { ...check, answerQuote: "伪造回答" } : check),
    checks.map((check, i) => i === 0 ? { ...check, evidence: [{ chunkId: sources[0].chunkId, quote: "伪造原文" }] } : check),
    checks.map((check, i) => i === 0 ? { ...check, evidence: [{ chunkId: "nonexistent", quote: "应保留票据" }] } : check),
    checks.map((check, i) => i === 3 ? { ...check, verdict: "not-applicable" } : check),
    checks.map((check, i) => i === 3 ? { ...check, evidence: [] } : check),
  ]) assert.throws(() => validateQualityOutput(JSON.stringify({ checks: invalid }), criteria, answer, sources), { code: "UPSTREAM_FAILED" });
});

test("a correct refusal can pass review after related but insufficient evidence was retrieved", async t => {
  await document("费用核销应保留票据，资料没有规定住宿额度。");
  const original = languageModel.doGenerate.bind(languageModel);
  let calls = 0;
  const answer = "资料未规定住宿额度，现有证据不足，无法确定金额。";
  t.mock.method(languageModel, "doGenerate", async options => {
    const response = await original(options); calls++;
    return { ...response, content: [{ type: "text", text: calls === 1 ? answer : JSON.stringify({ checks: [
      { id: "grounding", verdict: "not-applicable", reason: "未断言住宿金额。", answerQuote: null, evidence: [] },
      { id: "citations", verdict: "not-applicable", reason: "没有需要引用的金额断言。", answerQuote: null, evidence: [] },
      { id: "answerability", verdict: "pass", reason: "明确说明资料不足。", answerQuote: "现有证据不足", evidence: [] },
    ] }) }] };
  });
  const row = (await evaluateDocuments(evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, judgeAnswers: true, cases: [{ question: "费用核销住宿额度", answerable: false }] }), new AbortController().signal)).cases[0];
  assert.equal(row.unexpectedEvidence, true); assert.equal(row.quality.status, "complete");
  assert.equal(row.quality.checks.find(check => check.id === "answerability").verdict, "pass");
});

test("quality criteria preserve conditions, exceptions, quantities, conflicts and uncertain verdicts separately", async () => {
  const expectations = [
    { kind: "condition" as const, statement: "申请须经主管批准。" }, { kind: "exception" as const, statement: "试用期也适用。" },
    { kind: "quantity" as const, statement: "期限是十个工作日而非自然日。" }, { kind: "conflict" as const, statement: "两份文件额度不同，应披露冲突。" },
  ];
  const criteria = qualityCriteria({ answerable: true, requiredFacts: [], expectations });
  assert.deepEqual(criteria.slice(3).map(item => item.kind), ["condition", "exception", "quantity", "conflict"]);
  const checks = criteria.map(criterion => ({ id: criterion.id, verdict: "uncertain", reason: "缺少足够证据，不能判定。", answerQuote: null, evidence: [] }));
  const result = validateQualityOutput(JSON.stringify({ checks }), criteria, "请补充资料。", []);
  assert.equal(result.filter(check => check.verdict === "uncertain").length, 7);
  assert.equal(result.filter(check => check.verdict === "pass").length, 0);
});

test("review input validates opt-in, model allowlisting and expectation bounds before external calls", async t => {
  let calls = 0; t.mock.method(languageModel, "doGenerate", async () => { calls++; throw new Error("Must not call"); });
  const base = { confirm: true, cases: [{ question: "费用核销" }] };
  for (const input of [
    { ...base, judgeAnswers: true }, { ...base, judgeModel: modelRef },
    { ...base, cases: [{ question: "问题", expectations: [{ kind: "other", statement: "规则" }] }] },
    { ...base, cases: [{ question: "问题", expectations: Array.from({ length: 13 }, () => ({ kind: "fact", statement: "规则" })) }] },
    { ...base, cases: [{ question: "问题", answerable: false, expectations: [{ kind: "fact", statement: "规则" }] }] },
  ]) {
    globalThis.__riaRateLimitStore?.clear();
    assert.equal((await route.POST(request(input))).status, 400);
  }
  globalThis.__riaRateLimitStore?.clear();
  await assert.rejects(evaluateDocuments(evaluationRequestSchema.parse({ ...base, generateAnswers: true, judgeAnswers: true, judgeModel: { providerId: "openrouter", modelId: "unknown/model" } }), new AbortController().signal));
  assert.equal(calls, 0); assert.equal(providerState.embeddingCalls.length, 0);
});

test("cancellation during review stops subsequent questions and never returns a completed report", async t => {
  await document("费用核销应保留票据。");
  const original = languageModel.doGenerate.bind(languageModel); const controller = new AbortController(); let calls = 0;
  t.mock.method(languageModel, "doGenerate", async options => {
    calls++; if (calls === 2) controller.abort();
    return original(options);
  });
  await assert.rejects(evaluateDocuments(evaluationRequestSchema.parse({ confirm: true, generateAnswers: true, judgeAnswers: true, cases: [{ question: "费用核销" }, { question: "费用核销第二题" }] }), controller.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(calls, 2);
});

test("the fifty-question quality corpus preserves structured expectations and exercises real local retrieval", async () => {
  assert.equal(qualityCorpus.cases.length, 50); assert.equal(qualityCorpus.documents.length, 8);
  assert.deepEqual(new Set(qualityCorpus.cases.flatMap(item => item.expectations?.map(expectation => expectation.kind) ?? [])), new Set(["condition", "quantity", "exception", "fact", "conflict"]));
  for (const item of qualityCorpus.documents) await document(item.text, item.filename, item.collection);
  let recalled = 0; let answerable = 0; let relatedButUnanswerable = 0;
  for (let start = 0; start < qualityCorpus.cases.length; start += 10) {
    const input = evaluationRequestSchema.parse({ confirm: true, cases: qualityCorpus.cases.slice(start, start + 10) });
    const report = await evaluateDocuments(input, new AbortController().signal);
    assert.equal(report.judgedAnswers, false); assert.equal(report.judgeModel, null);
    for (const row of report.cases) {
      assert.equal(row.status, "success"); assert.equal(row.answer, null); assert.equal(row.quality, null);
      if (row.answerable) { answerable++; if (row.documentRecall === 1) recalled++; }
      else if (row.unexpectedEvidence) relatedButUnanswerable++;
    }
  }
  assert.equal(answerable, 40); assert.equal(recalled, 40); assert.ok(relatedButUnanswerable >= 7);
  assert.equal(providerState.embeddingCalls.length, 0);
});

test("a query is embedded with its case kept, as the passages are", async () => {
  const doc = await document("The NAS keeps the SQLite file; WAL mode needs shared memory.", "nas.md", "运维");
  await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  const embedded: string[] = [];
  providerState.embeddingFunction = text => { embedded.push(text); return [1, 0, 0]; };
  await retrieveDocuments("  Can SQLite WAL run on a NAS?  ");
  const { searchKnowledge } = await import("@/tools/definitions/search-knowledge");
  await searchKnowledge({ query: "Can SQLite WAL run on a NAS?", topK: 6 });
  assert.deepEqual(embedded, ["Can SQLite WAL run on a NAS?", "Can SQLite WAL run on a NAS?"]);
});

test("a passage close in meaning outranks one that only shares a few of the question's words", async () => {
  providerState.embeddingFunction = text => text.includes("公务出行") ? [0.9, Math.sqrt(0.19), 0]
    : text.includes("月底") ? [0.3, Math.sqrt(0.91), 0] : text.includes("会议室") ? [0.1, Math.sqrt(0.99), 0] : [1, 0, 0];
  for (const [filename, text] of [["差旅.md", "公务出行的费用核销应在十个工作日内提交。"], ["零用.md", "零用的钱在月底前领回来即可。"], ["会议.md", "会议室需提前一天预订。"]]) {
    const doc = await document(text, filename);
    await indexDocumentEmbeddings(doc.id, doc.contentHash, modelRef);
  }
  // Adding ranks put the passage sharing 钱 and 领回来, second by meaning, above the answer.
  const result = await retrieveDocuments("出门办事的钱怎样领回来");
  assert.equal(result.sources[0]?.filename, "差旅.md");
  assert.equal(result.sources[0]?.retrieval, "semantic");
});
