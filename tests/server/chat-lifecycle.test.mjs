import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database.mjs";
import { languageModel, providerState } from "../helpers/model-provider.mjs";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { createSession } = await import("@/lib/auth/session");
const { saveChatMessage } = await import("@/lib/chat/store");
const chat = await import("@/app/api/chat/route");
let user, cookie;
beforeEach(async (t) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  providerState.streamGate = undefined;
  providerState.streamError = false;
  user = await db.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  cookie = `app_session=${await createSession(user.id)}`;
});
after(async () => { await db.$disconnect(); cleanup(); });
const ui = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] });
function request(body, signal) {
  return new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ manualToolsOnly: true, ...body }), signal });
}

test("long persisted conversations pass bounded historical excerpts and the active turn through the chat route", async () => {
  const owned = await db.chat.create({ data: { userId: user.id, title: "Long conversation" } });
  const history = Array.from({ length: 40 }, (_, index) => ui(`turn-${index}`, index % 2 ? "assistant" : "user", `Recorded turn ${index}`));
  await db.message.createMany({ data: history.map((item) => ({ chatId: owned.id, clientMessageId: item.id, role: item.role, content: item.parts[0].text })) });
  const response = await chat.POST(request({ chatId: owned.id, messages: [...history, ui("follow-up", "user", "Explain the previous answer")] }));
  assert.equal(response.status, 200);
  await response.text();
  const prompt = languageModel.doStreamCalls.at(-1).prompt;
  assert.ok(prompt.length <= 25);
  assert.match(prompt.find((item) => item.role === "system").content, /Incomplete excerpts from .* earlier messages/);
  assert.equal(prompt.at(-1).content[0].text, "Explain the previous answer");
  assert.ok(prompt.some((item) => item.role === "assistant" && item.content[0].text === "Recorded turn 39"));
  assert.equal(await db.message.count({ where: { chatId: owned.id } }), 42);
  assert.equal(await db.message.count({ where: { chatId: owned.id, content: { startsWith: "Recorded turn" } } }), 40);
});

for (const regenerate of [false, true]) {
  test(`aborting ${regenerate ? "regeneration preserves the original answer" : "a chat stream never records partial output as successful"}`, { timeout: 15_000 }, async () => {
    const owned = await db.chat.create({ data: { userId: user.id, title: "Abort" } });
    await saveChatMessage({ chatId: owned.id, role: "user", content: "Question", clientMessageId: "user-1" });
    if (regenerate) await saveChatMessage({ chatId: owned.id, role: "assistant", content: "Original answer", clientMessageId: "answer-1" });
    let release;
    providerState.streamGate = new Promise((resolve) => { release = resolve; });
    const controller = new AbortController();
    const response = await chat.POST(request({ chatId: owned.id, ...(regenerate ? { trigger: "regenerate-message" } : {}), messages: [ui("user-1", "user", "Question")] }, controller.signal));
    const reader = response.body.getReader();
    let wire = "";
    try {
      while (!wire.includes("text-delta")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        wire += new TextDecoder().decode(chunk.value);
      }
      controller.abort();
      release();
      while (!(await reader.read()).done) { /* Drain persistence callbacks before touching SQLite. */ }
    } finally { release(); reader.releaseLock(); }
    const rows = await db.message.findMany({ where: { chatId: owned.id, role: "assistant" } });
    if (regenerate) {
      assert.deepEqual(rows.map(({ content, status }) => ({ content, status })), [{ content: "Original answer", status: "success" }]);
    } else {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "error");
    }
  });
}
