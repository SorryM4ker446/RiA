import assert from "node:assert/strict";
import { test, beforeEach, after, type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences, CHAT_MODEL_REF } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";
const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const chatRoute = await import("@/app/api/chat/route");
const runRoute = await import("@/app/api/conversations/[id]/runs/route");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { mapStoredMessagesToUI } = await import("@/features/chat/page-utils");
const { createChat } = await import("@/lib/chat/store");
const { saveAssistant } = await import("@/lib/assistants/store");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const request = (url: string, method = "GET", body?: unknown, auth = localAccessCookie()) => new NextRequest(`http://localhost${url}`, { method, headers: { cookie: auth, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  globalThis.__privateAiRateLimitStore?.clear(); resetProviderState();
  process.env.OPENROUTER_API_KEY = "offline-key"; process.env.DEEPSEEK_API_KEY = ""; process.env.TAVILY_API_KEY = "";
  await db.chat.deleteMany({}); await db.agentRun.deleteMany({}); await seedTestModelPreferences(db);
});
after(async () => { await db.$disconnect(); cleanup(); });

test("execution details use the persisted server run identity after reload and reject cross-conversation access", async () => {
  const conversation = await createChat({ title: "Record details" });
  const response = await chatRoute.POST(request("/api/chat", "POST", { chatId: conversation.id, model: CHAT_MODEL_REF, messages: [{ id: "user-detail", role: "user", metadata: { runId: "forged-run" }, parts: [{ type: "text", text: "Hello" }] }] }));
  assert.equal(response.status, 200); const stream = await response.text();
  const saved = await db.message.findFirstOrThrow({ where: { chatId: conversation.id, role: "assistant" } });
  const payload = decodePersistedAssistantToolMessage(saved.content)!;
  assert.ok(payload.runId); assert.notEqual(payload.runId, "forged-run");
  assert.match(stream, new RegExp(payload.runId));
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: payload.runId } });
  assert.equal(run.chatId, conversation.id);
  const get = (chatId: string, runId: string, auth?: string) => runRoute.GET(request(`/api/conversations/${chatId}/runs?runId=${runId}`, "GET", undefined, auth), { params: Promise.resolve({ id: chatId }) });
  const details = await get(conversation.id, run.id);
  assert.equal(details.status, 200); assert.match(details.headers.get("cache-control")!, /no-store/);
  const restored = mapStoredMessagesToUI([(await details.json()).data]).uiMessages[0];
  assert.equal((restored.metadata as any).runId, run.id);
  assert.equal((restored.metadata as any).modelLabel, `${CHAT_MODEL_REF.providerId}/${CHAT_MODEL_REF.modelId}`);
  const other = await createChat({ title: "Another" });
  assert.equal((await get(other.id, run.id)).status, 404);
  assert.equal((await get(conversation.id, run.id, "")).status, 401);
  assert.equal((await get(conversation.id, "invalid%22id")).status, 400);
});

test("a template with no tools is described as template-disabled, while configured provider search is never reported as missing Tavily", async () => {
  for (const restricted of [false, true]) {
    const template = restricted ? await saveAssistant(assistantConfigSchema.parse({ name: "No tools", instructions: "Be helpful", tools: [] })) : null;
    const conversation = await createChat({ title: "Prompt status", ...(template ? { assistantTemplateId: template.id } : {}) });
    const response = await chatRoute.POST(request("/api/chat", "POST", { chatId: conversation.id, model: CHAT_MODEL_REF, messages: [{ id: `user-${restricted}`, role: "user", parts: [{ type: "text", text: "Hello" }] }] }));
    assert.equal(response.status, 200); await response.text();
    const prompt = JSON.stringify(languageModel.doStreamCalls.at(-1)?.prompt);
    assert.doesNotMatch(prompt, /webSearch is not configured/);
    if (restricted) assert.match(prompt, /webSearch is disabled by the current assistant template/);
    else assert.doesNotMatch(prompt, /Capability status \(internal context\): webSearch/);
  }
});
