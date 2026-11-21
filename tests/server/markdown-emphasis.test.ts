import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MarkdownMessage } = await import("@/components/chat/markdown-message");

/** What the transcript draws for an answer, without the wrapper around it. */
const drawn = (text: string, streaming = false) => renderToStaticMarkup(createElement(MarkdownMessage, { text, streaming }))
  .replace(/<div[^>]*>|<\/div>/g, "").replace(/>\s+</g, "><").trim();
const strong = (text: string) => [...drawn(text).matchAll(/<strong>(.*?)<\/strong>/g)].map(match => match[1]);

test("bold ends after Chinese punctuation even when a letter follows it", () => {
  assert.deepEqual(strong("**总体判断：**项目工程化"), ["总体判断："]);
  assert.match(drawn("**总体判断：**项目工程化"), /<strong>总体判断：<\/strong>项目工程化/);
  assert.deepEqual(strong("**一句话。**下一句"), ["一句话。"]);
  // Full-width brackets, quotes and the enumeration comma close it too; so does punctuation that opens it.
  for (const sample of ["**（注意）**后文", "**“引用”**后文", "**甲、**乙", "前文**：说明**后文"]) assert.equal(strong(sample).length, 1, sample);
});

test("what CommonMark already does is unchanged: ordinary bold, English punctuation, spaces inside the markers", () => {
  assert.deepEqual(strong("**加粗**"), ["加粗"]);
  assert.deepEqual(strong("中文**加粗**中文"), ["加粗"]);
  assert.deepEqual(strong("**Note:** the text"), ["Note:"]);
  // English text after punctuation keeps CommonMark's rule: it needs the space.
  assert.deepEqual(strong("**Note:**text"), []);
  assert.match(drawn("**Note:**text"), /\*\*Note:\*\*text/);
  // Markers with space inside are not emphasis, in either language.
  assert.deepEqual(strong("** 加粗 **"), []);
  assert.deepEqual(strong("**加粗 **后文"), []);
});

test("adjacent and nested emphasis pair up as written", () => {
  assert.deepEqual(strong("**甲：**乙，**丙：**丁"), ["甲：", "丙："]);
  assert.match(drawn("**外层*内层：*外层**"), /<strong>外层<em>内层：<\/em>外层<\/strong>/);
  assert.match(drawn("*斜体：*后文"), /<em>斜体：<\/em>后文/);
});

test("an unfinished marker while the answer streams shows as written, and becomes bold once the rest arrives", () => {
  const partial = drawn("**总体判断：项目", true);
  assert.ok(!partial.includes("<strong>"));
  assert.ok(partial.replace(/<[^>]+>/g, "").includes("**总体判断：项目"));
  assert.equal(drawn("**总体判断：**项目工程化", true).replace(/<span[^>]*>|<\/span>/g, ""), drawn("**总体判断：**项目工程化"));
});

test("escaped asterisks, code, links and prices are left as they are", () => {
  assert.match(drawn("\\*\\*不是加粗：\\*\\*后文"), /\*\*不是加粗：\*\*后文/);
  assert.deepEqual(strong("\\*\\*不是加粗：\\*\\*后文"), []);
  assert.match(drawn("`**代码：**项`"), /<code>\*\*代码：\*\*项<\/code>/);
  assert.match(drawn("```\n**块：**项\n```"), /\*\*块：\*\*项/);
  assert.match(drawn("[**链接：**说明](https://example.invalid)"), /<a href="https:\/\/example.invalid"[^>]*><strong>链接：<\/strong>说明<\/a>/);
  assert.match(drawn("单价 $5，**合计：**$10"), /单价 \$5，<strong>合计：<\/strong>\$10/);
});
