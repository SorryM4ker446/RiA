import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { after, before, test, type TestContext } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { fetchPage, readWebPage, isPrivateAddress, htmlToMarkdown, WEB_PAGE_LIMITS } = await import("@/lib/web/page-reader");
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
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.6.35", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1", "::ffff:c0a8:1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
});

test("cached local pages still require the current message context to name their destination", async () => {
  const input = { url: `${origin}/notes.txt`, maxCharacters: 1000 };
  const address = new URL(input.url);
  const first = await readWebPage(input, { userText: [`read ${address.host}`] });
  assert.ok(first.nextOffset);
  const next = { ...input, offset: first.nextOffset! };
  await assert.rejects(readWebPage(next, { userText: [`read ${address.hostname}:1`] }), /private network/);
  await assert.rejects(readWebPage(next, { userText: [`read the reference at https://docs.example/notes/${address.host}`] }), /private network/);
  for (const named of [input.url, `请读取${input.url}`, `[本地文件](${input.url})`, `${address.host}${address.pathname}`]) {
    assert.equal((await readWebPage(next, { userText: [named] })).offset, first.nextOffset);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("stopping a page read releases it while system DNS is still pending", { timeout: 5000 }, async t => {
  const started = deferred<void>();
  const pending = deferred<{ address: string; family: number }[]>();
  t.after(() => pending.resolve([]));
  t.mock.method(dns, "lookup", () => {
    started.resolve();
    return pending.promise;
  });
  const controller = new AbortController();
  const stopped = assert.rejects(fetchPage("https://news.example/article", { userText: [], signal: controller.signal }), /stopped/i);
  await started.promise;
  controller.abort();
  await stopped;
});

function useEnvironment(t: TestContext, name: string, value?: string) {
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function fixturePort(t: TestContext, server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

test("web reads honor the outbound proxy and fake-IP opt-in, connecting only to checked IPs", async t => {
  // Self-signed fixture for the loopback HTTPS server. Trust it only in this test.
  const cert = readFileSync(new URL("../fixtures/web-proxy/test-certificate.pem", import.meta.url), "utf8");
  const key = readFileSync(new URL("../fixtures/web-proxy/test-key.pem", import.meta.url));
  const trusted = getCACertificates("default");
  setDefaultCACertificates([...trusted, cert]);
  t.after(() => setDefaultCACertificates(trusted));

  const publicAddress = "93.184.216.34";
  const fakeAddress = "198.18.6.35";
  const pageRequests: string[] = [];
  const dnsQueries: string[] = [];
  const bypass = `http://bypass.example:${new URL(origin).port}/article`;
  let truncated = false;
  let mismatchedQuestion = false;
  let dnsRedirect = false;
  const tlsServer = createHttpsServer({ cert, key }, (request, response) => {
    const target = new URL(request.url!, `https://${request.headers.host}`);
    if (target.hostname === "cloudflare-dns.com" && target.pathname === "/dns-query") {
      assert.equal(request.headers.accept, "application/dns-json");
      const name = target.searchParams.get("name");
      const type = target.searchParams.get("type");
      dnsQueries.push(`${name}:${type}`);
      const resolved = name === "private.example" ? "192.168.0.12" : publicAddress;
      if (dnsRedirect) {
        response.writeHead(302, { location: bypass });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/dns-json" });
      response.end(JSON.stringify({
        Status: 0, TC: truncated,
        Question: [{ name: mismatchedQuestion ? "wrong.example." : `${name?.toUpperCase()}.`, type: type === "A" ? 1 : 28 }],
        ...(type === "A" ? { Answer: [{ type: 1, data: resolved }] } : {}),
      }));
      return;
    }
    pageRequests.push(`${target.hostname}${target.pathname}`);
    if (target.pathname === "/redirect") {
      response.writeHead(302, { location: "https://private.example/article" });
    } else if (target.pathname === "/redirect-direct") {
      response.writeHead(307, { location: bypass });
    } else {
      response.writeHead(200, { "content-type": "text/html" });
    }
    response.end(article);
  });
  const tlsPort = await fixturePort(t, tlsServer);
  const tunnels: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, downstream, head) => {
    const target = request.url!;
    tunnels.push(target);
    const port = target === "cloudflare-dns.com:443" || target === `${publicAddress}:443` ? tlsPort
      : target === `${publicAddress}:80` ? new URL(origin).port : null;
    if (!port) { downstream.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
    const upstream = connect({ host: "127.0.0.1", port: Number(port) }, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
    });
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => upstream.destroy());
  });
  const proxyPort = await fixturePort(t, proxy);
  useEnvironment(t, "OUTBOUND_PROXY_URL", `http://127.0.0.1:${proxyPort}`);
  useEnvironment(t, "no_proxy", `bypass.example:${new URL(origin).port}`);
  useEnvironment(t, "RIA_WEB_FAKE_IP_DOH");
  let fake = false;
  const lookup = async (host: string) => {
    if (host === "mixed.example") return [{ address: fakeAddress, family: 4 }, { address: "192.168.0.12", family: 4 }];
    const address = host === "bypass.example" ? "127.0.0.1" : fake ? fakeAddress : publicAddress;
    return [{ address, family: 4 }];
  };
  t.mock.method(dns, "lookup", lookup);
  const read = (url: string, userText: string[] = []) => fetchPage(url, { userText });
  const page = "https://news.example/article";

  // A hostname excluded by NO_PROXY stays direct, even after it resolves to an IP.
  assert.match((await read(bypass, [bypass])).bytes.toString(), /Release notes/);
  assert.deepEqual(tunnels, []);
  assert.match((await read("http://news.example/article")).bytes.toString(), /Release notes/);
  assert.deepEqual(tunnels, [`${publicAddress}:80`]);

  fake = true;
  await assert.rejects(read(page), /fake-IP/i);
  assert.deepEqual(dnsQueries, []);
  assert.equal(tunnels.length, 1);

  process.env.RIA_WEB_FAKE_IP_DOH = "1";
  await assert.rejects(read("https://mixed.example/article"), /private network/);
  assert.deepEqual(dnsQueries, []);
  fake = false;
  assert.equal((await read(page)).url, page);
  assert.equal(pageRequests.at(-1), "news.example/article");
  assert.deepEqual(dnsQueries, []);
  await assert.rejects(read("https://wrong.example/article"), /could not be fetched/i);
  assert.equal(pageRequests.length, 1, "the original hostname still has to match the TLS certificate");
  tunnels.length = 0;

  fake = true;
  assert.equal((await read(page)).url, page);
  assert.equal(pageRequests.at(-1), "news.example/article");
  assert.deepEqual(dnsQueries.sort(), ["news.example:A", "news.example:AAAA"]);
  assert.deepEqual([...new Set(tunnels)].sort(), [`${publicAddress}:443`, "cloudflare-dns.com:443"].sort());

  dnsQueries.length = 0;
  tunnels.length = 0;
  await assert.rejects(read("https://news.example/redirect"), /fake-IP/i);
  assert.deepEqual(dnsQueries.sort(), ["news.example:A", "news.example:AAAA", "private.example:A", "private.example:AAAA"]);
  assert.equal(tunnels.filter(target => target === `${publicAddress}:443`).length, 1);
  assert.ok(tunnels.every(target => [`${publicAddress}:443`, "cloudflare-dns.com:443"].includes(target)));

  const redirect = { url: "https://news.example/redirect-direct" };
  dnsQueries.length = 0;
  tunnels.length = 0;
  assert.equal((await readWebPage(redirect, { userText: [bypass] })).url, bypass);
  assert.deepEqual(dnsQueries.sort(), ["news.example:A", "news.example:AAAA"]);
  assert.deepEqual([...new Set(tunnels)].sort(), [`${publicAddress}:443`, "cloudflare-dns.com:443"].sort());
  const beforeCachedRead = tunnels.length;
  assert.equal((await readWebPage(redirect, { userText: [bypass] })).url, bypass);
  assert.equal(tunnels.length, beforeCachedRead);
  await assert.rejects(readWebPage(redirect, { userText: [redirect.url] }), /private network/);

  truncated = true;
  tunnels.length = 0;
  await assert.rejects(read(page), /fake-IP/i);
  assert.ok(tunnels.length > 0 && tunnels.every(target => target === "cloudflare-dns.com:443"));
  truncated = false;
  mismatchedQuestion = true;
  tunnels.length = 0;
  await assert.rejects(read(page), /fake-IP/i);
  assert.ok(tunnels.length > 0 && tunnels.every(target => target === "cloudflare-dns.com:443"));
  mismatchedQuestion = false;
  dnsRedirect = true;
  tunnels.length = 0;
  await assert.rejects(read(page), /fake-IP/i);
  assert.ok(tunnels.length > 0 && tunnels.every(target => target === "cloudflare-dns.com:443"));
});

test("stopping a page read closes a pending proxy tunnel", { timeout: 5000 }, async t => {
  const started = deferred<void>();
  const closed = deferred<void>();
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    socket.on("close", () => closed.resolve());
    socket.on("end", () => socket.end());
    // Consume until the client closes. The proxy hasn't accepted the tunnel.
    socket.resume();
    started.resolve();
  });
  useEnvironment(t, "OUTBOUND_PROXY_URL", `http://127.0.0.1:${await fixturePort(t, proxy)}`);
  useEnvironment(t, "no_proxy", "");
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const controller = new AbortController();
  const stopped = assert.rejects(fetchPage("https://news.example/article", { userText: [], signal: controller.signal }), /stopped/i);
  await started.promise;
  controller.abort();
  await stopped;
  await closed.promise;
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
