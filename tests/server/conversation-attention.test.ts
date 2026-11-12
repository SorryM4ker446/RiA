import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { listConversations } = await import("@/lib/conversations/query");
const { updateConversation, markTurnAnswered } = await import("@/lib/conversations/mutations");
const { holdTurn } = await import("@/lib/chat/live-turns");
const { onConversationsChanged } = await import("@/lib/conversations/events");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");

beforeEach(async () => { await db.scheduledJob.deleteMany(); await db.chat.deleteMany(); });
after(async () => { await db.$disconnect(); cleanup(); });

const answer = (state: string) => encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [{ toolCallId: "call", toolName: "runTerminalCommand", state, input: { command: "dir" } }] } as never);

test("a conversation in the list says when its latest answer waits for an approval, and when its task is running", async () => {
  const waiting = await db.chat.create({ data: { title: "Waiting", messages: { create: [{ role: "user", content: "Run it" }, { role: "assistant", content: answer("approval-requested"), createdAt: new Date(Date.now() + 1000) }] } } });
  const answered = await db.chat.create({ data: { title: "Answered", messages: { create: [{ role: "assistant", content: answer("approval-requested") }, { role: "user", content: "Never mind", createdAt: new Date(Date.now() + 1000) }] } } });
  const finished = await db.chat.create({ data: { title: "Finished", messages: { create: [{ role: "assistant", content: answer("output-available") }] } } });
  const tasked = await db.chat.create({ data: { title: "Tasked" } });
  await db.scheduledJob.create({ data: { kind: "prompt", title: "Brief", prompt: "Write it.", timeZone: "UTC", nextRunAt: null, chatId: tasked.id, lastStatus: "running" } });

  const { data } = await listConversations(new URLSearchParams());
  const byTitle = Object.fromEntries(data.map(chat => [chat.title, chat]));
  assert.equal(byTitle.Waiting.awaitingApproval, true);
  assert.equal(byTitle.Answered.awaitingApproval, false, "a later message passed the request by");
  assert.equal(byTitle.Finished.awaitingApproval, false);
  assert.deepEqual([byTitle.Tasked.task?.running, byTitle.Waiting.task], [true, null]);

  // A change made to the conversation reads back the same state.
  assert.equal((await updateConversation(waiting.id, { pinned: true })).awaitingApproval, true);
  assert.equal((await updateConversation(answered.id, { pinned: true })).awaitingApproval, false);
  await db.scheduledJob.updateMany({ data: { lastStatus: "done" } });
  assert.equal((await updateConversation(finished.id, { title: "Done" })).task, null);
  assert.equal((await listConversations(new URLSearchParams())).data.find(chat => chat.title === "Tasked")?.task?.running, false);
});

test("a conversation says when it is answering, and an answer that ended unseen stays unread until opened", async () => {
  const chat = await db.chat.create({ data: { title: "Elsewhere" } });
  const changes: number[] = [];
  const off = onConversationsChanged(() => changes.push(Date.now()));
  const read = async () => (await listConversations(new URLSearchParams())).data.find(item => item.id === chat.id)!;
  assert.deepEqual([(await read()).answering, (await read()).unread], [false, false]);

  // Held by the service: answering, whoever reads the list.
  let finish!: () => void;
  const response = await holdTurn(chat.id, async () => new Response(new ReadableStream({ start(controller) { finish = () => controller.close(); } }), { headers: { "content-type": "text/event-stream" } }), { source: "chat", settle: markTurnAnswered });
  assert.equal((await read()).answering, true);
  finish();
  await new Response(response.body).arrayBuffer();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([(await read()).answering, (await read()).unread], [false, true]);
  assert.ok(changes.length > 0, "the sidebar was told");

  // Opening it reads it; only clearing comes from outside.
  assert.equal((await updateConversation(chat.id, { unread: false })).unread, false);
  // A turn the user stopped there leaves nothing unread.
  await markTurnAnswered(chat.id, "stopped");
  assert.equal((await read()).unread, false);
  await markTurnAnswered(chat.id, "waiting_approval");
  assert.equal((await read()).unread, true);
  off();
});
