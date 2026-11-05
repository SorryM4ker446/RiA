import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMessageTime, readMessageTime } from "@/features/chat/message-time";
import { mapStoredMessagesToUI } from "@/features/chat/page-utils";
import { encodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";

// Local times on both sides, so these hold in any time zone.
const now = new Date(2026, 10, 4, 15, 0);

test("a message reads as short as still says when, and always as an exact time", () => {
  assert.equal(formatMessageTime(new Date(2026, 10, 4, 14, 32), now), "14:32");
  assert.equal(formatMessageTime(new Date(2026, 10, 3, 23, 59), now), "昨天 23:59");
  assert.equal(formatMessageTime(new Date(2026, 10, 2, 9, 5), now), "11月2日 9:05");
  assert.equal(formatMessageTime(new Date(2026, 0, 1, 9, 5), now), "1月1日 9:05");
  assert.equal(formatMessageTime(new Date(2025, 11, 31, 23, 59), now), "2025年12月31日 23:59", "last December is not yesterday's year");
});

test("yesterday is by the calendar, not the last 24 hours", () => {
  const justAfterMidnight = new Date(2026, 10, 4, 0, 1);
  assert.equal(formatMessageTime(new Date(2026, 10, 3, 23, 59), justAfterMidnight), "昨天 23:59");
  assert.equal(formatMessageTime(new Date(2026, 10, 2, 23, 59), new Date(2026, 10, 3, 23, 59)), "昨天 23:59");
  // A clock change makes that day 23 or 25 hours long; both are still one day back.
  assert.match(formatMessageTime(new Date(2026, 2, 8, 12, 0), new Date(2026, 2, 9, 1, 0)), /^昨天 /);
  assert.match(formatMessageTime(new Date(2026, 9, 25, 12, 0), new Date(2026, 9, 26, 23, 0)), /^昨天 /);
});

test("a clock set back shows the date instead of claiming today", () => {
  assert.equal(formatMessageTime(new Date(2026, 10, 5, 9, 0), now), "11月5日 9:00");
});

test("a time that cannot be read is no time at all", () => {
  assert.equal(readMessageTime(undefined), null);
  assert.equal(readMessageTime({}), null);
  assert.equal(readMessageTime({ createdAt: 12 }), null);
  assert.equal(readMessageTime({ createdAt: "not a date" }), null);
  assert.equal(readMessageTime({ createdAt: "2026-11-04T06:32:00.000Z" })?.toISOString(), "2026-11-04T06:32:00.000Z");
});

test("every kind of stored message brings its time, from a row or from the API", () => {
  const at = "2026-11-04T06:32:00.000Z";
  const base = { clientMessageId: null };
  const { uiMessages } = mapStoredMessagesToUI([
    { ...base, id: "plain-user", role: "user", content: "问题", createdAt: at },
    { ...base, id: "plain-answer", role: "assistant", content: "回答", createdAt: new Date(at) },
    { ...base, id: "tool-answer", role: "assistant", createdAt: at, content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "回答", tools: [], runId: "run-1" }) },
    { ...base, id: "image", role: "assistant", createdAt: at, content: JSON.stringify({ type: "image-result", dataUrl: "data:image/png;base64,AA==", text: "图片" }) },
    { ...base, id: "unknown", role: "user", content: "没有时间" },
    { ...base, id: "broken", role: "user", content: "时间坏了", createdAt: "not a date" },
  ]);
  for (const id of ["plain-user", "plain-answer", "tool-answer", "image"]) {
    assert.equal(readMessageTime(uiMessages.find(message => message.id === id)?.metadata)?.toISOString(), at, id);
  }
  assert.equal((uiMessages.find(message => message.id === "tool-answer")?.metadata as { runId?: string }).runId, "run-1", "what the message already carried stays");
  assert.equal(uiMessages.find(message => message.id === "unknown")?.metadata, undefined);
  assert.equal(uiMessages.find(message => message.id === "broken")?.metadata, undefined);
});
