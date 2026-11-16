import assert from "node:assert/strict";
import { test } from "node:test";

const { attachTurn, holdTurn, isTurnLive, isTurnQueued, onTurnEvent, stopTurn } = await import("@/lib/chat/live-turns");
const { setSlotCapacity, slotForCall, slotUsage } = await import("@/lib/models/call-slots");
let capacity = 8;
setSlotCapacity(async () => capacity);

const encoder = new TextEncoder();
const sse = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);

/** A turn whose chunks are released by the test, ending when told or when its signal stops it. */
function scriptedTurn(headers: Record<string, string> = {}) {
  let push!: (chunk: object) => void, end!: () => void, signal!: AbortSignal;
  const start = async (given: AbortSignal) => {
    signal = given;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = chunk => controller.enqueue(sse(chunk));
        end = () => controller.close();
        given.addEventListener("abort", () => { controller.enqueue(sse({ type: "abort" })); controller.close(); }, { once: true });
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", ...headers } });
  };
  return { start, push: (chunk: object) => push(chunk), end: () => end(), signal: () => signal };
}

async function readAll(response: Response) {
  return new TextDecoder().decode(await new Response(response.body).arrayBuffer());
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("a held turn keeps running when its reader leaves, and anyone attaching reads it from the start", async () => {
  const events: unknown[] = [];
  const off = onTurnEvent(event => events.push(event));
  const turn = scriptedTurn();
  const first = await holdTurn("held", turn.start, { source: "chat" });
  turn.push({ type: "start", messageId: "a" });
  turn.push({ type: "text-delta", id: "t", delta: "Hel" });
  // The page that sent the message goes away mid-answer.
  await first.body!.cancel();
  await settle();
  assert.equal(isTurnLive("held"), true);
  assert.equal(turn.signal().aborted, false, "leaving is not stopping");

  // Opened again: everything said so far, then what follows, to the end.
  const again = attachTurn("held")!;
  assert.ok(again);
  const reading = readAll(again);
  turn.push({ type: "text-delta", id: "t", delta: "lo" });
  turn.push({ type: "finish" });
  turn.end();
  const text = await reading;
  assert.match(text, /"messageId":"a"[\s\S]*"delta":"Hel"[\s\S]*"delta":"lo"[\s\S]*"finish"/);
  await settle();
  assert.equal(isTurnLive("held"), false);
  assert.equal(attachTurn("held"), null, "nothing to attach to once it ended");
  assert.deepEqual(events, [
    { type: "turn-started", chatId: "held", source: "chat", queued: false },
    { type: "turn-finished", chatId: "held", source: "chat", outcome: "succeeded" },
  ]);
  off();
});

test("stopping ends the turn through its signal, and a second turn in the same conversation waits its turn", async () => {
  const events: unknown[] = [];
  const off = onTurnEvent(event => events.push(event));
  const turn = scriptedTurn();
  const response = await holdTurn("busy", turn.start, { source: "task" });
  const reading = readAll(response);
  let started = false;
  await assert.rejects(holdTurn("busy", async () => { started = true; return new Response(""); }, { source: "chat" }), (error: { code?: string }) => error.code === "CONFLICT");
  assert.equal(started, false, "refused before anything of it starts");

  assert.equal(stopTurn("busy"), true);
  assert.equal(turn.signal().aborted, true);
  await reading;
  await settle();
  assert.equal(stopTurn("busy"), false, "nothing left to stop");
  assert.deepEqual(events.at(-1), { type: "turn-finished", chatId: "busy", source: "task", outcome: "stopped" });
  off();
});

test("the request that started a task's turn ending stops it; a turn that asks or fails says so", async () => {
  const events: { type: string; outcome?: string; errorCode?: string; chatId?: string }[] = [];
  const off = onTurnEvent(event => events.push(event));
  const outer = new AbortController();
  const stopped = scriptedTurn();
  const reading = readAll(await holdTurn("outer", stopped.start, { source: "task", outer: outer.signal }));
  outer.abort();
  await reading;
  assert.equal(stopped.signal().aborted, true);

  const asking = scriptedTurn();
  const asked = readAll(await holdTurn("asking", asking.start, { source: "chat" }));
  asking.push({ type: "tool-approval-request", approvalId: "x", toolCallId: "y" });
  asking.end();
  await asked;

  const failing = scriptedTurn();
  const failed = readAll(await holdTurn("failing", failing.start, { source: "chat" }));
  failing.push({ type: "error", errorText: JSON.stringify({ error: { code: "RATE_LIMITED" } }) });
  failing.end();
  await failed;
  await settle();
  const finished = events.filter(event => event.type === "turn-finished").map(({ chatId, outcome, errorCode }) => ({ chatId, outcome, errorCode }));
  assert.deepEqual(finished, [
    { chatId: "outer", outcome: "stopped", errorCode: undefined },
    { chatId: "asking", outcome: "waiting_approval", errorCode: undefined },
    { chatId: "failing", outcome: "failed", errorCode: "RATE_LIMITED" },
  ]);
  off();
});

test("a turn that cannot start leaves nothing behind, and one in a new conversation is known by the id it was given", async () => {
  await assert.rejects(holdTurn("broken", async () => { throw new Error("no model"); }, { source: "chat" }));
  assert.equal(isTurnLive("broken"), false);

  const turn = scriptedTurn({ "x-chat-id": "made" });
  const reading = readAll(await holdTurn("placeholder", turn.start, { source: "chat" }));
  assert.equal(isTurnLive("made"), true);
  assert.equal(isTurnLive("placeholder"), false);
  turn.end();
  await reading;
});

/** Reads a stream until `until` appears in what it said, leaving the rest unread. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: string, sofar = "") {
  const decoder = new TextDecoder();
  while (!sofar.includes(until)) { const item = await reader.read(); if (item.done) break; sofar += decoder.decode(item.value); }
  return sofar;
}

/** A turn whose model call is made after it has started, as an answer's steps are, and held until released. */
function turnWithCall(priority: "foreground" | "background", options: { signal?: AbortSignal } = {}) {
  const turn = scriptedTurn();
  let release: (() => void) | null = null, granted = false, failed: unknown = null;
  const start = async (given: AbortSignal) => {
    const response = await turn.start(given);
    // Started inside the turn, so the call tells the turn while it waits.
    void slotForCall(priority, options.signal ?? given).then(slot => { release = slot.release; granted = true; }, error => { failed = error; });
    return response;
  };
  return { ...turn, start, granted: () => granted, failed: () => failed, release: () => { release?.(); release = null; } };
}

test("a turn holds no place while it is not calling a model, so another turn starts at once beside it", async () => {
  capacity = 1;
  const busy = scriptedTurn(), other = scriptedTurn();
  const busyReading = readAll(await holdTurn("tools-running", busy.start, { source: "task" }));
  let started = false;
  const otherReading = readAll(await holdTurn("beside-it", async signal => { started = true; return other.start(signal); }, { source: "chat" }));
  assert.equal(started, true, "nothing waits for the first turn's tools");
  assert.equal(isTurnQueued("beside-it"), false);
  assert.equal(slotUsage().inUse, 0, "neither turn holds a place of its own");
  busy.end(); other.end(); await busyReading; await otherReading;
  capacity = 8;
});

test("a call waits for a place another call holds; its turn says it is queued, then running, and gives the place back", async () => {
  capacity = 1;
  const events: { type: string; chatId: string }[] = [];
  const off = onTurnEvent(event => events.push(event));
  const inFlight = await slotForCall("background");
  const turn = turnWithCall("foreground");
  const response = await holdTurn("waiting-call", turn.start, { source: "chat" });
  const reader = response.body!.getReader();
  const waiting = await readUntil(reader, "data-turn-status");
  assert.match(waiting, /"state":"queued","ahead":0/);
  assert.equal(isTurnQueued("waiting-call"), true);
  assert.equal(turn.granted(), false);
  // The other call ends: this one runs, and the turn says so.
  inFlight.release();
  await settle();
  assert.equal(turn.granted(), true);
  assert.equal(isTurnQueued("waiting-call"), false);
  turn.push({ type: "text-delta", id: "t", delta: "answer" });
  turn.release();
  turn.end();
  const rest = await readUntil(reader, "answer", waiting);
  assert.match(rest, /"state":"running"[\s\S]*"delta":"answer"/);
  await settle();
  assert.deepEqual(events.filter(event => event.chatId === "waiting-call").map(event => event.type), ["turn-started", "turn-queued", "turn-running", "turn-finished"]);
  assert.equal(slotUsage().inUse, 0, "every place is given back");
  off();
  capacity = 8;
});

test("the user's calls go before a task's waiting for the same place", async () => {
  capacity = 1;
  const inFlight = await slotForCall("foreground");
  const task = turnWithCall("background"), chat = turnWithCall("foreground");
  const taskReading = readAll(await holdTurn("task-call", task.start, { source: "task" }));
  await settle();
  const chatReading = readAll(await holdTurn("chat-call", chat.start, { source: "chat" }));
  await settle();
  assert.equal(slotUsage().waiting, 2);
  inFlight.release(); await settle();
  assert.deepEqual([chat.granted(), task.granted()], [true, false], "the user's call went first though it asked second");
  chat.release(); await settle();
  assert.equal(task.granted(), true);
  task.release();
  task.end(); chat.end(); await taskReading; await chatReading; await settle();
  assert.equal(slotUsage().inUse, 0);
  capacity = 8;
});

test("stopping a turn whose call waits takes the call out of the queue, and the turn ends as stopped", async () => {
  capacity = 1;
  const inFlight = await slotForCall("foreground");
  const events: { type: string; chatId: string; outcome?: string }[] = [];
  const off = onTurnEvent(event => events.push(event));
  const turn = turnWithCall("foreground");
  const reading = readAll(await holdTurn("stopped-waiting", turn.start, { source: "chat" }));
  await settle();
  assert.equal(slotUsage().waiting, 1);
  assert.equal(stopTurn("stopped-waiting"), true);
  assert.match(await reading, /"type":"abort"/);
  await settle();
  assert.equal(slotUsage().waiting, 0, "the waiting call left the queue");
  assert.equal(turn.granted(), false);
  assert.ok(turn.failed(), "the call was given up, not granted later");
  assert.deepEqual(events.filter(event => event.chatId === "stopped-waiting" && event.type === "turn-finished").map(event => event.outcome), ["stopped"]);
  inFlight.release();
  await settle();
  assert.equal(slotUsage().inUse, 0);
  off();
  capacity = 8;
});
