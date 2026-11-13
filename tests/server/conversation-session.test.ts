import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

// The browser's storage, as the session keeps drafts and queues in it.
const storage = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
};

const { ConversationSession, DRAFT_CHAT, HistoryUnavailableError, forgetSession, keepUnchanged, keptSessions, openSession, sessionFor } = await import("@/features/chat/conversation-session");
type Session = InstanceType<typeof ConversationSession>;

/** A service stand-in: each request is answered by the script given, or refused. */
function service(script: (push: (chunk: UIMessageChunk) => void, end: () => void) => void | "refuse") {
  const requests: UIMessage[][] = [];
  let reconnects = 0;
  const transport: ChatTransport<UIMessage> = {
    async sendMessages({ messages, abortSignal }) {
      requests.push(messages);
      let push!: (chunk: UIMessageChunk) => void, end!: () => void;
      const stream = new ReadableStream<UIMessageChunk>({ start(controller) {
        push = chunk => controller.enqueue(chunk);
        end = () => controller.close();
        // Stopping reading ends the request, as it does for the real transport.
        abortSignal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } });
      if (script(chunk => push(chunk), () => end()) === "refuse") throw new Error("Service unavailable");
      return stream;
    },
    async reconnectToStream() { reconnects++; return null; },
  };
  return { transport, requests, reconnects: () => reconnects };
}
const answer = (text: string) => (push: (chunk: UIMessageChunk) => void, end: () => void) => {
  push({ type: "start", messageId: `answer-${text}` });
  push({ type: "text-start", id: "t" });
  push({ type: "text-delta", id: "t", delta: text });
  push({ type: "text-end", id: "t" });
  push({ type: "finish" });
  end();
};
const userMessage = (text: string): UIMessage => ({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] });
const stored = (id: string, role: "user" | "assistant", content: string) => ({ id, clientMessageId: null, role, content, status: "success" as const });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const texts = (session: Session) => session.chat.messages.map(message => message.parts.map(part => part.type === "text" ? part.text : "").join(""));

test("a sent message leaves the message box, and a refused one comes back unless something new was written", async () => {
  const ok = service(answer("Hello"));
  const session = new ConversationSession("send-ok", ok.transport, { history: "ready" });
  session.setDraft({ text: "Hi", attachments: [] });
  const taken = session.takeDraft();
  assert.deepEqual(session.getSnapshot().draft, { text: "", attachments: [] });
  assert.equal(await session.send(userMessage(taken.text), {}), false);
  assert.deepEqual(texts(session), ["Hi", "Hello"]);

  const refused = new ConversationSession("send-refused", service(() => "refuse").transport, { history: "ready" });
  refused.setDraft({ text: "Lost?", attachments: [] });
  const sent = refused.takeDraft();
  assert.equal(await refused.send(userMessage(sent.text), {}), true, "the request failed");
  assert.equal(refused.restoreDraft(sent), true);
  assert.equal(refused.getSnapshot().draft.text, "Lost?");
  // Written again meanwhile: what is new stays.
  refused.setDraft({ text: "Newer", attachments: [] });
  assert.equal(refused.restoreDraft(sent), false);
  assert.equal(refused.getSnapshot().draft.text, "Newer");
});

test("a send the service answered has not failed, however its answer was cut short", async () => {
  // The answer starts, then the connection drops (a reload, the network): the message is with the service.
  const cut = service((push, end) => {
    push({ type: "start", messageId: "partial" });
    push({ type: "text-start", id: "t" });
    push({ type: "text-delta", id: "t", delta: "Half an" });
    end();
  });
  const dropped = new ConversationSession("send-cut", {
    ...cut.transport,
    async sendMessages(request) {
      const stream = await cut.transport.sendMessages(request);
      // The stream errors after what was said: as a request cut off part way does.
      const reader = stream.getReader();
      return new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.error(new TypeError("Failed to fetch"));
          else controller.enqueue(next.value);
        },
      });
    },
  }, { history: "ready" });
  assert.equal(await dropped.send(userMessage("Keep me"), {}), false, "not a send to write again");
});

test("a send waits for the history, so reading it cannot replace what was sent", async () => {
  let release!: () => void;
  const reading = new Promise<void>(resolve => { release = resolve; });
  const session = new ConversationSession("waits", service(answer("Answer")).transport, {
    readHistory: async () => { await reading; return { data: [stored("u0", "user", "Earlier"), stored("a0", "assistant", "Earlier answer")] }; },
  });
  const sending = session.send(userMessage("Now"), {});
  await settle();
  assert.equal(session.getSnapshot().history, "loading", "an unread history is read first");
  release();
  assert.equal(await sending, false);
  assert.deepEqual(texts(session), ["Earlier", "Earlier answer", "Now", "Answer"]);

  const unreadable = new ConversationSession("unreadable", service(answer("x")).transport, { readHistory: async () => { throw new Error("down"); } });
  await assert.rejects(unreadable.send(userMessage("Now"), {}), HistoryUnavailableError);
  assert.equal(unreadable.chat.messages.length, 0, "nothing was sent");
});

test("only the latest history read lands, and a quiet one redraws only what changed", async () => {
  const replies: Array<(value: { data: unknown[] }) => void> = [];
  const session = new ConversationSession("reads", service(answer("x")).transport, { readHistory: () => new Promise(resolve => replies.push(resolve)) });
  const first = session.loadHistory();
  const second = session.loadHistory();
  replies[1]({ data: [stored("new", "user", "Newer read")] });
  await second;
  replies[0]({ data: [stored("old", "user", "Older read")] });
  await first;
  assert.deepEqual(texts(session), ["Newer read"], "the older read did not land after the newer one");

  const kept = session.chat.messages[0];
  const quiet = session.loadHistory({ quiet: true });
  replies[2]({ data: [stored("new", "user", "Newer read"), stored("added", "assistant", "Added elsewhere")] });
  await quiet;
  assert.equal(session.chat.messages[0], kept, "an unchanged message is the same object");
  assert.deepEqual(texts(session), ["Newer read", "Added elsewhere"]);
  assert.equal(session.getSnapshot().history, "ready");

  // Something happened in it while the quiet read was out: the read leaves it alone.
  const late = session.loadHistory({ quiet: true });
  session.chat.messages = [...session.chat.messages, userMessage("Typed meanwhile")];
  replies[3]({ data: [stored("new", "user", "Newer read")] });
  await late;
  assert.equal(texts(session).at(-1), "Typed meanwhile");
});

test("keepUnchanged gives back the list shown when nothing differs, and keeps unchanged messages", () => {
  const message = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
  const shown = [message("a", "one"), message("b", "two")];
  assert.equal(keepUnchanged(shown, [message("a", "one"), message("b", "two")]), shown);
  const edited = keepUnchanged(shown, [message("a", "one"), message("b", "changed elsewhere")]);
  assert.equal(edited[0], shown[0]);
  assert.notEqual(edited[1], shown[1]);
});

test("a queued notice holds until the turn moves on, and a retry notice for as long as it says", async () => {
  const session = new ConversationSession("notices", service((push, end) => {
    push({ type: "data-turn-status", data: { state: "retrying", attempt: 1, seconds: 0.05 }, transient: true } as UIMessageChunk);
    setTimeout(() => { answer("done")(push, end); }, 200);
  }).transport, { history: "ready" });
  const sending = session.send(userMessage("Q"), {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(session.getSnapshot().notice?.state, "retrying");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(session.getSnapshot().notice, null, "the retry's wait is over");
  await sending;

  const queued = new ConversationSession("queued", service((push, end) => {
    push({ type: "data-turn-status", data: { state: "queued", ahead: 2 }, transient: true } as UIMessageChunk);
    setTimeout(() => { answer("done")(push, end); }, 30);
  }).transport, { history: "ready" });
  const waiting = queued.send(userMessage("Q"), {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(queued.getSnapshot().notice, { state: "queued", ahead: 2 });
  await waiting;
  assert.equal(queued.getSnapshot().notice, null, "said until the turn moved on");
});

test("drafts and queues are kept in the browser, so a session made again reads them back", () => {
  const first = new ConversationSession("kept-draft", service(answer("x")).transport);
  first.hydrate();
  first.setDraft({ text: "Half written", attachments: [] });
  first.setQueue(() => [{ id: "q1", text: "Next", attachments: [] }]);
  const again = new ConversationSession("kept-draft", service(answer("x")).transport);
  again.hydrate();
  assert.equal(again.getSnapshot().draft.text, "Half written");
  assert.deepEqual(again.getSnapshot().queue.map(item => item.text), ["Next"]);
  // A draft moved in before it was read back is newer than what was stored; the queue is still read.
  const moved = new ConversationSession("kept-draft", service(answer("x")).transport);
  moved.setDraft({ text: "Moved in", attachments: [] }, { typed: false });
  moved.hydrate();
  assert.equal(moved.getSnapshot().draft.text, "Moved in");
  assert.deepEqual(moved.getSnapshot().queue.map(item => item.text), ["Next"]);
  // Emptied, nothing is kept.
  moved.takeDraft();
  moved.setQueue(() => []);
  const empty = new ConversationSession("kept-draft", service(answer("x")).transport);
  empty.hydrate();
  assert.deepEqual([empty.getSnapshot().draft.text, empty.getSnapshot().queue.length], ["", 0]);
});

test("a session follows a turn it is not already reading, once, and not its own again after it ends", async () => {
  const own = service(answer("Mine"));
  const session = new ConversationSession("follow", own.transport, { history: "ready" });
  await session.send(userMessage("Q"), {});
  // Its own turn just ended while the service is still said to be answering.
  session.follow(true);
  assert.equal(own.reconnects(), 0, "its own turn is not read again");
  session.follow(false);
  // Someone else's turn begins: followed once.
  session.othersTurnStarted();
  session.follow(true);
  session.follow(true);
  await settle();
  assert.equal(own.reconnects(), 1);
});

test("sessions are kept for going back to: answers read in the background up to a bound, others as last seen", async () => {
  const endless = () => service(push => { push({ type: "start", messageId: "m" }); push({ type: "text-start", id: "t" }); push({ type: "text-delta", id: "t", delta: "…" }); });
  const answering: Session[] = [];
  for (const id of ["bg-1", "bg-2", "bg-3"]) {
    const { session } = sessionFor(id, () => new ConversationSession(id, endless().transport, { history: "ready" }));
    openSession(id);
    void session.send(userMessage("Q"), {});
    await settle();
    answering.push(session);
  }
  assert.equal(sessionFor("bg-2", () => { throw new Error("made again"); }).reused, true, "an open one is given back");
  sessionFor("bg-open", () => new ConversationSession("bg-open", service(answer("x")).transport));
  openSession("bg-open");
  const ids = () => keptSessions().map(entry => entry.id);
  assert.ok(!ids().includes("bg-1"), "the one seen longest ago stops being read here");
  assert.ok(ids().includes("bg-2") && ids().includes("bg-3"));
  await settle();
  assert.equal(answering[0].chat.status, "ready", "and was stopped here only");
  // The new conversation's session is never kept.
  assert.notEqual(sessionFor(DRAFT_CHAT, () => new ConversationSession(DRAFT_CHAT, service(answer("x")).transport)).session, sessionFor(DRAFT_CHAT, () => new ConversationSession(DRAFT_CHAT, service(answer("x")).transport)).session);
  // Not answering: six kept as last seen.
  const idle = Array.from({ length: 8 }, (_, index) => `idle-${index}`);
  for (const id of idle) { sessionFor(id, () => new ConversationSession(id, service(answer("x")).transport)); openSession(id); }
  openSession(null);
  assert.deepEqual(ids().filter(id => id.startsWith("idle-")).sort(), idle.slice(2).sort());
  for (const id of [...ids()]) forgetSession(id);
  assert.deepEqual(keptSessions(), []);
});
