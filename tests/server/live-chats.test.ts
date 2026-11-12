import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

const { chatFor, forgetChat, keptChats, openChat, DRAFT_CHAT } = await import("@/features/chat/live-chats");

/** A chat client stand-in: its status, and whether reading it was stopped here. */
function fakeChat(status: "ready" | "submitted" | "streaming" = "ready") {
  const chat = { status, stopped: false, stop: async () => { chat.stopped = true; chat.status = "ready"; } };
  return chat as typeof chat & Chat<UIMessage>;
}
const kept = () => keptChats().map(entry => entry.id).sort();

test("a conversation's client is kept and given back, and the new conversation's never is", () => {
  const first = fakeChat();
  assert.equal(chatFor("keep-a", () => first).reused, false);
  const again = chatFor("keep-a", () => fakeChat());
  assert.equal(again.reused, true);
  assert.equal(again.chat, first, "the same client, showing what it showed");
  const draft = chatFor(DRAFT_CHAT, () => fakeChat());
  assert.equal(draft.reused, false);
  assert.notEqual(chatFor(DRAFT_CHAT, () => fakeChat()).chat, draft.chat, "a new conversation starts empty each time");
  assert.ok(!kept().includes(DRAFT_CHAT));
  forgetChat("keep-a");
  assert.ok(!kept().includes("keep-a"));
});

test("answers go on being read in the background up to a bound, the least recently seen let go first", () => {
  const answering = ["bg-1", "bg-2", "bg-3"].map(id => ({ id, chat: fakeChat("streaming") }));
  for (const { id, chat } of answering) { chatFor(id, () => chat); openChat(id); }
  // Now on a fourth: the three answering ones are in the background.
  chatFor("bg-open", () => fakeChat());
  openChat("bg-open");
  assert.equal(answering[0].chat.stopped, true, "the one seen longest ago stops being read here");
  assert.deepEqual([answering[1].chat.stopped, answering[2].chat.stopped], [false, false]);
  assert.ok(!kept().includes("bg-1"), "and is read again from the service when opened");
  assert.ok(kept().includes("bg-2") && kept().includes("bg-3"));
  // The open one is never let go, answering or not.
  openChat("bg-2");
  assert.ok(kept().includes("bg-2"));
  for (const id of ["bg-2", "bg-3", "bg-open"]) forgetChat(id);
});

test("conversations not answering are kept as last seen up to a bound, and one removed is stopped and forgotten", () => {
  const ids = Array.from({ length: 8 }, (_, index) => `idle-${index}`);
  for (const id of ids) { chatFor(id, () => fakeChat()); openChat(id); }
  openChat(null);
  // Six kept, the two seen longest ago let go.
  assert.deepEqual(kept().filter(id => id.startsWith("idle-")), ids.slice(2).sort());
  const live = fakeChat("streaming");
  chatFor("removed", () => live);
  forgetChat("removed");
  assert.equal(live.stopped, true);
  assert.ok(!kept().includes("removed"));
  for (const id of ids) forgetChat(id);
});

test("reading the saved history again keeps every unchanged message as it was shown", async () => {
  const { keepUnchanged } = await import("@/features/chat/live-chats");
  const message = (id: string, text: string) => ({ id, role: "user" as const, parts: [{ type: "text" as const, text }] });
  const shown = [message("a", "one"), message("b", "two")];
  assert.equal(keepUnchanged(shown, [message("a", "one"), message("b", "two")]), shown, "nothing differs: the list shown stays");
  const edited = keepUnchanged(shown, [message("a", "one"), message("b", "changed elsewhere")]);
  assert.notEqual(edited, shown);
  assert.equal(edited[0], shown[0], "an unchanged message is the same object");
  assert.equal(edited[1].parts[0].type === "text" && edited[1].parts[0].text, "changed elsewhere");
  const added = keepUnchanged(shown, [...shown.map(item => ({ ...item })), message("c", "new")]);
  assert.deepEqual(added.map(item => item.id), ["a", "b", "c"]);
  assert.equal(added[1], shown[1]);
});
