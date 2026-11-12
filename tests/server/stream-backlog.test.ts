import assert from "node:assert/strict";
import { test } from "node:test";

const { compactBacklog } = await import("@/lib/chat/stream-backlog");
const encoder = new TextEncoder();
const event = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const events = (text: string) => text.split("\n\n").filter(Boolean).map(line => line === "data: [DONE]" ? "[DONE]" : JSON.parse(line.slice(6)));

test("a late reader gets each part's deltas in one, and everything else as it was, in order", () => {
  const said = [
    event({ type: "start", messageId: "m" }),
    event({ type: "reasoning-start", id: "r" }),
    ...["Thinking", " it", " over"].map(delta => event({ type: "reasoning-delta", id: "r", delta })),
    event({ type: "reasoning-end", id: "r" }),
    event({ type: "text-start", id: "t" }),
    ...["你", "好", "，", "world"].map(delta => event({ type: "text-delta", id: "t", delta })),
    event({ type: "data-turn-status", data: { state: "running" }, transient: true }),
    event({ type: "text-delta", id: "t", delta: "!" }),
  ].join("");
  // Bytes cut anywhere, even inside a character.
  const bytes = encoder.encode(said);
  const chunks = [bytes.subarray(0, 37), bytes.subarray(37, 120), bytes.subarray(120, 121), bytes.subarray(121)];
  assert.deepEqual(events(new TextDecoder().decode(compactBacklog(chunks))), [
    { type: "start", messageId: "m" },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "Thinking it over" },
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "你好，world" },
    { type: "data-turn-status", data: { state: "running" }, transient: true },
    { type: "text-delta", id: "t", delta: "!" },
  ]);
});

test("a delta with more than its text, or of another part, is not merged into its neighbour", () => {
  const said = encoder.encode([
    event({ type: "text-delta", id: "a", delta: "one" }),
    event({ type: "text-delta", id: "a", delta: "two", providerMetadata: { x: { y: 1 } } }),
    event({ type: "text-delta", id: "b", delta: "three" }),
    event({ type: "text-delta", id: "b", delta: "four" }),
    "data: [DONE]\n\n",
  ].join(""));
  assert.deepEqual(events(new TextDecoder().decode(compactBacklog([said]))), [
    { type: "text-delta", id: "a", delta: "one" },
    { type: "text-delta", id: "a", delta: "two", providerMetadata: { x: { y: 1 } } },
    { type: "text-delta", id: "b", delta: "threefour" },
    "[DONE]",
  ]);
});

test("an event still being written at the end is passed on untouched, for what follows to complete", () => {
  const whole = event({ type: "text-delta", id: "t", delta: "a" }) + event({ type: "text-delta", id: "t", delta: "b" });
  const partial = encoder.encode(`data: {"type":"text-delta","id":"t","delta":"中`).subarray(0, -1);
  const compacted = compactBacklog([encoder.encode(whole), partial]);
  const tail = compacted.subarray(compacted.length - partial.length);
  assert.deepEqual([...tail], [...partial], "the unfinished bytes are kept as they were");
  assert.deepEqual(events(new TextDecoder().decode(compacted.subarray(0, compacted.length - partial.length))), [{ type: "text-delta", id: "t", delta: "ab" }]);
  assert.deepEqual([...compactBacklog([partial])], [...partial], "with no whole event there is nothing to merge");
});
