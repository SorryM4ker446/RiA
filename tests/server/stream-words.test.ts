import assert from "node:assert/strict";
import { test } from "node:test";
import type { Element, ElementContent, Root } from "hast";
import { rehypeStreamWords, splitWords } from "../../src/components/chat/stream-words";

const text = (parts: ElementContent[]) => parts.map(part => part.type === "text" ? part.value : ((part as Element).children[0] as { value: string }).value).join("");
const words = (parts: ElementContent[]) => parts.filter(part => part.type === "element").map(part => ((part as Element).children[0] as { value: string }).value);

test("splitting into words keeps every character, keeps spaces as plain text and punctuation with its word", () => {
  const value = "Draft the report, about 40 min. 先把最要紧的放在前面。";
  const parts = splitWords(value);
  assert.equal(text(parts), value);
  assert.ok(parts.filter(part => part.type === "text").every(part => /^\s+$/.test((part as { value: string }).value)));
  const split = words(parts);
  assert.ok(split.includes("report,"), split.join("|"));
  assert.ok(split.includes("min."), split.join("|"));
  assert.ok(split.at(-1)!.endsWith("。"), split.join("|"));
  assert.ok(split.every(word => !/^[,.。]/.test(word)), "no word starts with punctuation that follows another");
});

test("appending text leaves the words before it as they were, so only new words animate", () => {
  const before = words(splitWords("Weekly plan for the team"));
  const after = words(splitWords("Weekly plan for the team and its owners"));
  assert.deepEqual(after.slice(0, before.length), before);
});

test("code stays whole while running text around it is split", () => {
  const tree: Root = { type: "root", children: [
    { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "Run " }, { type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: "npm run dev" }] }, { type: "text", value: " now" }] },
    { type: "element", tagName: "pre", properties: {}, children: [{ type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: "const value = load();" }] }] },
  ] };
  rehypeStreamWords()(tree);
  const paragraph = tree.children[0] as Element;
  assert.deepEqual(paragraph.children.map(child => child.type === "element" ? (child as Element).tagName : "text"), ["span", "text", "code", "text", "span"]);
  const code = ((tree.children[1] as Element).children[0] as Element).children;
  assert.deepEqual(code, [{ type: "text", value: "const value = load();" }]);
});
