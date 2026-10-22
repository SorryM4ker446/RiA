import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LEGACY_PANEL_VISIBILITY_STORAGE_KEY, PANEL_VISIBILITY_STORAGE_KEY, readRenamedStorageItem } from "@/lib/ui-preferences";
import { clearChatDraft, readChatDraft, writeChatDraft } from "@/features/chat/draft";
import { readPanelVisibility } from "@/features/chat/preferences";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  failWrites = false;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error("QuotaExceededError"); this.values.set(key, value); }
}

function browser() {
  const localStorage = new MemoryStorage();
  Object.assign(globalThis, { window: { localStorage }, document: { documentElement: { dataset: {} } } });
  return localStorage;
}
afterEach(() => { delete (globalThis as { window?: unknown }).window; delete (globalThis as { document?: unknown }).document; });

test("a value saved under a pre-rename key is moved to the current key once", () => {
  const storage = new MemoryStorage();
  storage.setItem("old", "saved");
  assert.equal(readRenamedStorageItem(storage, "new", "old"), "saved");
  assert.equal(storage.getItem("new"), "saved");
  assert.equal(storage.getItem("old"), null);
  assert.equal(readRenamedStorageItem(storage, "new", "old"), "saved");
});

test("the current key wins over a stale legacy copy, and a failed move is retried", () => {
  const storage = new MemoryStorage();
  storage.setItem("new", "current"); storage.setItem("old", "stale");
  assert.equal(readRenamedStorageItem(storage, "new", "old"), "current");
  assert.equal(storage.getItem("old"), null, "the stale copy is discarded");

  const full = new MemoryStorage();
  full.setItem("old", "saved"); full.failWrites = true;
  assert.equal(readRenamedStorageItem(full, "new", "old"), "saved", "the legacy value is still read");
  assert.equal(full.getItem("old"), "saved", "kept until the move succeeds");
  full.failWrites = false;
  assert.equal(readRenamedStorageItem(full, "new", "old"), "saved");
  assert.equal(full.getItem("new"), "saved");
  assert.equal(full.getItem("old"), null);
});

test("panel visibility saved before the rename is kept and moved to the RiA key", () => {
  const storage = browser();
  storage.setItem(LEGACY_PANEL_VISIBILITY_STORAGE_KEY, JSON.stringify({ conversations: false, tasks: true }));
  assert.deepEqual(readPanelVisibility(), { conversations: false, tasks: true });
  assert.equal(PANEL_VISIBILITY_STORAGE_KEY, "ria.chat.panel-visibility");
  assert.equal(storage.getItem(PANEL_VISIBILITY_STORAGE_KEY), JSON.stringify({ conversations: false, tasks: true }));
  assert.equal(storage.getItem(LEGACY_PANEL_VISIBILITY_STORAGE_KEY), null);
});

test("an unsent draft saved before the rename is restored, moved, and cleared under both names", () => {
  const storage = browser();
  const draft = { text: "half-written question", attachments: [], updatedAt: Date.now() };
  storage.setItem("private-ai.chat.draft.chat-1", JSON.stringify(draft));
  assert.equal(readChatDraft("chat-1")?.text, "half-written question");
  assert.equal(storage.getItem("private-ai.chat.draft.chat-1"), null);
  assert.ok(storage.getItem("ria.chat.draft.chat-1"));

  storage.setItem("private-ai.chat.draft.chat-2", JSON.stringify(draft));
  writeChatDraft("chat-2", { text: "rewritten", attachments: [] });
  assert.equal(storage.getItem("private-ai.chat.draft.chat-2"), null, "a newer write supersedes the legacy draft");
  assert.equal(readChatDraft("chat-2")?.text, "rewritten");

  storage.setItem("private-ai.chat.draft.chat-3", JSON.stringify(draft));
  clearChatDraft("chat-3");
  assert.equal(storage.getItem("private-ai.chat.draft.chat-3"), null);
  assert.equal(readChatDraft("chat-3"), null, "a cleared draft does not come back from its old name");
});
