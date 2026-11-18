import assert from "node:assert/strict";
import { test } from "node:test";
import { batchItems } from "@/features/knowledge/document-batch";

const reasons = { unsupported: "unsupported", tooLarge: "too large", sameName: "same name", nameTooLong: "name too long" };
function file(name: string, path = "", content = "text") {
  const value = new File([content], name);
  if (path) Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}

test("files of a folder that share a name are named by their path in it, and the rest keep their own name", () => {
  const items = batchItems([
    file("readme.md", "Docs/finance/readme.md"), file("readme.md", "Docs/hr/team/readme.md"), file("policy.md", "Docs/policy.md"), file("photo.png", "Docs/photo.png"),
  ], reasons);
  assert.deepEqual(items.map(item => [item.name, item.documentName, item.status]), [
    ["Docs/finance/readme.md", "finance › readme.md", "waiting"],
    ["Docs/hr/team/readme.md", "hr › team › readme.md", "waiting"],
    ["Docs/policy.md", "policy.md", "waiting"],
    ["Docs/photo.png", "photo.png", "skipped"],
  ]);
});

test("files sharing a name with no folder path to tell them apart are skipped after the first", () => {
  const items = batchItems([file("notes.md"), file("notes.md"), file("notes.png"), file("other.md")], reasons);
  assert.deepEqual(items.map(item => [item.documentName, item.status, item.message]), [
    ["notes.md", "waiting", undefined], ["notes.md", "skipped", "same name"], ["notes.png", "skipped", "unsupported"], ["other.md", "waiting", undefined],
  ]);
});

test("a path too long for a document name is skipped with the reason", () => {
  const deep = `Docs/${"folder/".repeat(30)}readme.md`;
  const items = batchItems([file("readme.md", deep), file("readme.md", "Docs/a/readme.md")], reasons);
  assert.equal(items[0].status, "skipped");
  assert.equal(items[0].message, "name too long");
  assert.equal(items[1].documentName, "a › readme.md");
});
