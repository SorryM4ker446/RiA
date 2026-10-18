import assert from "node:assert/strict";
import { test } from "node:test";
import { presentToolMemory } from "../../src/features/knowledge/entry-presentation";

const key = "tool:webSearch:原神-genshin-impact-游戏评价-2025";
const value = ["version=tool-memory-v1", "tool=webSearch", "trigger=auto", "time=2026-09-17T02:57:00.393Z", "fingerprint=ce9cf191", "quality=0.650", "summary=Web 搜索「原神 Genshin Impact 游戏评价 2025」返回 4 条结果。", "tags=web-search", "assistant=## 原神\n\n**优点**：探索体验。\n第二段保留。"].join("\n");

test("tool memory presentation extracts readable titles and content without changing stored records", () => {
  const original = value;
  assert.deepEqual(presentToolMemory(key, value), { title: "原神 Genshin Impact 游戏评价 2025", toolLabel: "联网搜索", summary: "Web 搜索「原神 Genshin Impact 游戏评价 2025」返回 4 条结果。", excerpt: "## 原神\n\n**优点**：探索体验。\n第二段保留。" });
  assert.equal(value, original);
  assert.deepEqual(presentToolMemory(key, value.replaceAll("\n", "\r\n")), presentToolMemory(key, value));
});

test("manual notes, unsupported versions and malformed envelopes retain their plain representation", () => {
  for (const [recordKey, record] of [
    ["普通手动知识", value], [key, "tool=webSearch\nsummary=普通笔记"], [key, value.replace("tool-memory-v1", "tool-memory-v2")],
    [key, value.replace("tool=webSearch", "tool=searchKnowledge")], [key, value.replace("summary=Web 搜索「原神 Genshin Impact 游戏评价 2025」返回 4 条结果。", "summary=")],
    [key, value.replace("quality=0.650", "quality=NaN")], [key, value.replace("quality=0.650", "quality=1.5")],
    [key, value.replace("time=2026-09-17T02:57:00.393Z", "time=invalid")], [key, value.replace("trigger=auto", "trigger=unknown")],
    [key, value + "\nsummary=duplicate"], [key, value.replace("fingerprint=ce9cf191", "fingerprint=")], [key, value + "\ncustom=unsupported"],
  ]) assert.equal(presentToolMemory(recordKey, record), null);
});

test("tool memory without an answer retains its complete summary and falls back to a readable key suffix", () => {
  const record = value.slice(0, value.indexOf("\nassistant=")).replace("summary=Web 搜索「原神 Genshin Impact 游戏评价 2025」返回 4 条结果。", "summary=没有引号的摘要\n包含第二行");
  assert.deepEqual(presentToolMemory(key, record), { title: "原神 genshin impact 游戏评价 2025", toolLabel: "联网搜索", summary: "没有引号的摘要\n包含第二行", excerpt: "" });
  assert.equal(presentToolMemory("tool:customTool:some-subject", record.replace("tool=webSearch", "tool=customTool"))?.toolLabel, "工具记录");
});
