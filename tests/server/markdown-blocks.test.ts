import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { splitMarkdownBlocks } from "@/components/chat/markdown-blocks";
import { longAnswer, longReport } from "../helpers/stream-load";

const render = (text: string) => createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSanitize] }, text);
// Whitespace text between block elements is not rendered by the transcript.
const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/>\s+</g, "><").trim();
const whole = (text: string) => html(render(text));
const split = (text: string) => html(createElement(Fragment, null, ...splitMarkdownBlocks(text).map((block, key) => createElement(ReactMarkdown, { key, remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSanitize] }, block))));

const tricky: Record<string, string> = {
  "fence holding blank lines and a shorter fence": "intro\n\n````md\n```js\n\nconst a = 1;\n```\n\nstill code\n````\n\nafter",
  "tilde fence with an indented close": "~~~\n\nx\n   ~~~\n\nafter",
  "deeply indented fence text does not close": "```\na\n\n    ```\n\nstill code\n```\n\nafter",
  "backtick line with backticks in its info is inline code": "```inline``` text\n\nnext",
  "loose list with continuation": "- a\n\n- b\n\n  continued\n\nparagraph",
  "ordered lists with gaps": "1. a\n\n2. b\n\n10) c\n\nend",
  "list item holding a fence with blank lines": "- item\n\n  ```\n  code\n\n  more\n  ```\n\nafter",
  "indented code across blank lines": "para\n\n    code\n\n    more\n\nnext",
  "tab indented code": "para\n\n\tcode\n\n\tmore\n\nnext",
  "block quotes": "> a\n>\n> b\n\n> c\nlazy\n\nd",
  "headings, rules and tables": "Title\n===\n\ntext\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n* * *\n\n- x\n\n***\n\nend",
  "task lists": "- [ ] a\n\n- [x] b\n\ndone",
  "reference links": "[a][x] and [b]\n\n[x]: https://example.com\n[b]: https://example.org \"t\"",
  "footnotes": "claim[^1]\n\nmore\n\n[^1]: the note",
  "comment spanning blank lines": "<!-- c\n\n-->\n\ntext",
  "pre spanning blank lines": "<pre>\n\nx\n</pre>\n\ntext",
  "whitespace-only separator line": "a\n   \nb\n\t\nc",
  "carriage returns": "# h\r\n\r\npara\r\n\r\n- a\r\n\r\n- b\r\n",
  "emphasis and links": "**粗体** _斜体_ [链接](https://example.com) `代码`\n\n第二段 ~~删除~~ https://example.com",
};

test("split markdown renders exactly like the whole text, including every partial stream", () => {
  for (const [name, text] of Object.entries(tricky)) {
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      assert.equal(split(prefix), whole(prefix), `${name}: prefix ${JSON.stringify(prefix)}`);
    }
  }
  for (const text of [longAnswer, longReport(6)]) {
    assert.equal(split(text), whole(text));
    for (let end = 0; end <= text.length; end += 13) assert.equal(split(text.slice(0, end)), whole(text.slice(0, end)));
  }
});

test("long replies are split into many blocks and document-wide syntax is kept whole", () => {
  assert.ok(splitMarkdownBlocks(longReport(20)).length >= 80);
  assert.ok(splitMarkdownBlocks(longAnswer).length >= 40);
  for (const name of ["reference links", "footnotes", "comment spanning blank lines", "pre spanning blank lines"]) {
    assert.deepEqual(splitMarkdownBlocks(tricky[name]), [tricky[name]], name);
  }
  // Finished blocks keep identical text while the reply grows, so their parsed trees are reused.
  const report = longReport(4);
  const early = splitMarkdownBlocks(report.slice(0, report.length / 2));
  const later = splitMarkdownBlocks(report);
  assert.deepEqual(later.slice(0, early.length - 1), early.slice(0, -1));
  assert.equal(splitMarkdownBlocks(report).join("\n"), report);
});
