import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { readWebPage, isPrivateAddress, htmlToMarkdown, WEB_PAGE_LIMITS } = await import("@/lib/web/page-reader");
const { createChatToolSet } = await import("@/tools/catalog");
const { db } = await import("@/db");

const article = `<!doctype html><html><head><title>Release notes</title><meta charset="utf-8"></head><body>
<nav><a href="/">Home</a> · <a href="/blog">Blog</a></nav>
<article><h1>Version 1.2</h1><p>Released on Wednesday. It adds <a href="/docs/export">export to PDF</a> and fixes the login loop.</p>
<p>${"Details about the release that make this an article worth reading. ".repeat(20)}</p>
<pre><code>npm install ria@1.2</code></pre></article>
<script>window.track = 1</script><footer>© Someone</footer></body></html>`;

let server: Server, origin = "";
before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/article") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(article); return; }
    if (request.url === "/moved") { response.writeHead(302, { location: "/article" }); response.end(); return; }
    if (request.url === "/loop") { response.writeHead(302, { location: "/loop" }); response.end(); return; }
    if (request.url === "/notes.txt") { response.writeHead(200, { "content-type": "text/plain" }); response.end(Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n")); return; }
    if (request.url === "/huge") { response.writeHead(200, { "content-type": "text/plain" }); response.end(Buffer.alloc(WEB_PAGE_LIMITS.bytes + 10, 97)); return; }
    if (request.url === "/image") { response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.from([137, 80, 78, 71])); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await db.$disconnect(); cleanup(); });

// The tests' server is on this machine, so the user has to have named it.
const userText = () => [`please read ${origin}/article`];

test("a page's main content is read as Markdown, without its navigation or scripts, with absolute links", async () => {
  const page = await readWebPage({ url: `${origin}/article` }, { userText: userText() });
  assert.equal(page.title, "Release notes");
  assert.match(page.content, /Released on Wednesday/);
  assert.match(page.content, /\[export to PDF\]\(http:\/\/127\.0\.0\.1:\d+\/docs\/export\)/);
  assert.match(page.content, /```\s*\nnpm install ria@1\.2/);
  assert.doesNotMatch(page.content, /window\.track|Blog/);
  assert.equal(page.nextOffset, null);
});

test("redirects are followed and checked, and a page that redirects for ever is given up on", async () => {
  assert.equal((await readWebPage({ url: `${origin}/moved` }, { userText: userText() })).url, `${origin}/article`);
  await assert.rejects(readWebPage({ url: `${origin}/loop` }, { userText: userText() }), /redirected more than/);
});

test("an address on this computer or a private network is read only when the user named it", async () => {
  await assert.rejects(readWebPage({ url: `${origin}/notes.txt` }, { userText: ["summarise the release notes"] }), /private network/);
  await assert.rejects(readWebPage({ url: "http://localhost:1/x" }, { userText: ["read the page the file mentions"] }), /private network/);
  await assert.rejects(readWebPage({ url: "file:///C:/Windows/win.ini" }, { userText: userText() }), /Only http and https/);
  await assert.rejects(readWebPage({ url: "http://user:secret@example.com/" }, { userText: userText() }), /user name or password/);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
});

test("a long page is read in parts that end at a line break, and the page is fetched once", async () => {
  const first = await readWebPage({ url: `${origin}/notes.txt`, maxCharacters: 1000 }, { userText: userText() });
  assert.ok(first.content.endsWith("\n"));
  assert.ok(first.nextOffset! > 800 && first.nextOffset! <= 1000);
  const second = await readWebPage({ url: `${origin}/notes.txt`, offset: first.nextOffset!, maxCharacters: 1000 }, { userText: userText() });
  assert.equal(second.offset, first.nextOffset);
  assert.ok(second.content.startsWith("line "));
  assert.equal(second.totalCharacters, first.totalCharacters);
});

test("content that is too large or not readable is refused with the reason", async () => {
  await assert.rejects(readWebPage({ url: `${origin}/huge` }, { userText: userText() }), /larger than/);
  await assert.rejects(readWebPage({ url: `${origin}/image` }, { userText: userText() }), /not a readable page/);
  await assert.rejects(readWebPage({ url: `${origin}/missing` }, { userText: userText() }), /HTTP 404/);
});

test("a page Readability cannot handle still gives its text", () => {
  const page = htmlToMarkdown("<html><body><p>Just one line.</p></body></html>", "https://example.com/");
  assert.match(page.content, /Just one line\./);
});

test("the model is offered the reader with what it may read", async () => {
  const tools = await createChatToolSet({ toolIds: ["readWebPage"] });
  assert.ok(tools.readWebPage);
  assert.match(String(tools.readWebPage.description), /private-network/);
});
