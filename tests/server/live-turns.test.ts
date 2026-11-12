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

test("with every place taken a turn waits and says so, keeps the message first, and starts when a place frees", async () => {
  capacity = 1;
  const events: { type: string; chatId: string; queued?: boolean }[] = [];
  const off = onTurnEvent(event => events.push(event));
  const first = scriptedTurn();
  const firstReading = readAll(await holdTurn("first", first.start, { source: "chat" }));
  let started = false, kept = false;
  const second = scriptedTurn();
  const response = await holdTurn("second", async signal => { started = true; return second.start(signal); }, { source: "chat", beforeQueue: async () => { kept = true; } });
  assert.equal(started, false, "nothing of it runs while it waits");
  assert.equal(kept, true, "the message was kept before the response came back");
  assert.equal(isTurnQueued("second"), true);
  const reader = response.body!.getReader();
  const waiting = await readUntil(reader, "data-turn-status");
  assert.match(waiting, /"state":"queued","ahead":0/);
  // The first ends: the second takes its place, says it is running, and answers.
  first.end();
  await firstReading;
  await settle();
  assert.equal(started, true);
  assert.equal(isTurnQueued("second"), false);
  second.push({ type: "text-delta", id: "t", delta: "answer" });
  second.end();
  const rest = await readUntil(reader, "answer", waiting);
  assert.match(rest, /"state":"running"[\s\S]*"delta":"answer"/);
  await settle();
  assert.deepEqual(events.filter(event => event.chatId === "second").map(event => event.type), ["turn-started", "turn-running", "turn-finished"]);
  assert.equal(events.find(event => event.chatId === "second")?.queued, true);
  assert.equal(slotUsage().inUse, 0, "every place is given back");
  off();
  capacity = 8;
});

test("a queued turn can be given up before it starts: nothing runs and its stream ends", async () => {
  capacity = 1;
  const holding = scriptedTurn();
  const holdingReading = readAll(await holdTurn("holding", holding.start, { source: "chat" }));
  let started = false;
  const response = await holdTurn("given-up", async () => { started = true; return new Response(""); }, { source: "chat" });
  const ended = readAll(response);
  assert.equal(stopTurn("given-up"), true);
  assert.match(await ended, /"type":"abort"/);
  assert.equal(started, false);
  assert.equal(isTurnLive("given-up"), false);
  holding.end();
  await holdingReading;
  await settle();
  assert.equal(slotUsage().inUse, 0);
  assert.equal(slotUsage().waiting, 0);
  capacity = 8;
});

test("the user's turns go before a task's waiting for the same place, and a turn's own calls use its place", async () => {
  capacity = 1;
  const order: string[] = [];
  const holding = scriptedTurn();
  const holdingReading = readAll(await holdTurn("holder", async signal => {
    // Inside the turn: its calls take no further place, even with none free.
    const slot = await slotForCall("foreground");
    assert.equal(slot.own, false);
    return holding.start(signal);
  }, { source: "chat" }));
  const task = scriptedTurn(), chat = scriptedTurn();
  const taskReading = readAll(await holdTurn("task-turn", async signal => { order.push("task"); return task.start(signal); }, { source: "task" }));
  const chatReading = readAll(await holdTurn("chat-turn", async signal => { order.push("chat"); return chat.start(signal); }, { source: "chat" }));
  holding.end(); await holdingReading; await settle();
  assert.deepEqual(order, ["chat"], "the user's turn went first though it asked second");
  chat.end(); await chatReading; await settle();
  assert.deepEqual(order, ["chat", "task"]);
  task.end(); await taskReading; await settle();
  assert.equal(slotUsage().inUse, 0);
  capacity = 8;
});

test("a turn that cannot start after waiting says why on its stream", async () => {
  capacity = 1;
  const holding = scriptedTurn();
  const holdingReading = readAll(await holdTurn("busy-holder", holding.start, { source: "chat" }));
  const events: { type: string; chatId: string; outcome?: string; errorCode?: string }[] = [];
  const off = onTurnEvent(event => events.push(event));
  const response = await holdTurn("cannot-start", async () => { const { ApiError } = await import("@/lib/server/api-error"); throw new ApiError({ code: "CONFIGURATION_ERROR", message: "No key" }); }, { source: "chat" });
  const reading = readAll(response);
  holding.end(); await holdingReading;
  const text = await reading;
  await settle();
  assert.match(text, /"type":"error"[\s\S]*CONFIGURATION_ERROR[\s\S]*No key/);
  assert.deepEqual(events.filter(event => event.chatId === "cannot-start" && event.type === "turn-finished").map(event => [event.outcome, event.errorCode]), [["failed", "CONFIGURATION_ERROR"]]);
  assert.equal(slotUsage().inUse, 0);
  off();
  capacity = 8;
});

