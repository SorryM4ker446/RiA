import dns from "node:dns/promises";
import { addAbortListener } from "node:events";
import { BlockList, isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { parseDocument } from "@/lib/documents/parser";
import { ApiError } from "@/lib/server/api-error";
import { tf } from "@/lib/locale";
import { outboundProxyOptions, proxyTunnelClient } from "@/lib/server/proxy";
import { resolveCloudflareAddresses } from "./cloudflare-dns";

/*
 * Reading one web page for the model: the page is fetched by this service
 * (no search provider involved), its main content is turned into Markdown,
 * and long pages are read in parts. Pages are only fetched over http(s), from
 * public addresses; a local or private address (a dev server, a router) only
 * when the user wrote that address themselves, so a page or file the model
 * read cannot send it into the local network. The address that was checked is
 * the one connected to.
 */

export const WEB_PAGE_LIMITS = {
  bytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
  redirects: 10,
  defaultCharacters: 20_000,
  maxCharacters: 200_000,
  /** Pages kept for reading on in parts, and for how long. */
  cachedPages: 30,
  cacheMs: 15 * 60_000,
} as const;

export type WebPage = { url: string; title: string; siteName: string | null; contentType: string; content: string };
export type WebPageSlice = { url: string; title: string; siteName: string | null; contentType: string; content: string; offset: number; nextOffset: number | null; totalCharacters: number };

const refuse = (message: string) => new ApiError({ code: "VALIDATION_ERROR", message });
const failed = (message: string) => new ApiError({ code: "UPSTREAM_FAILED", message });

const fakeIpAddresses = new BlockList();
fakeIpAddresses.addSubnet("198.18.0.0", 15);
fakeIpAddresses.addSubnet("fdfe:dcba:9876::", 64, "ipv6");
const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublicV4.addSubnet(address, prefix);
const mappedV4 = new BlockList();
mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const nonPublicV6 = new BlockList();
nonPublicV6.addSubnet("2001:db8::", 32, "ipv6");
nonPublicV6.addSubnet("3fff::", 20, "ipv6");

function isFakeAddress(address: string) {
  return fakeIpAddresses.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** Whether an address belongs outside the public internet. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || isFakeAddress(address)) return true;
  if (family === 4) return nonPublicV4.check(address);
  if (mappedV4.check(address, "ipv6")) return nonPublicV4.check(address, "ipv6");
  return !globalV6.check(address, "ipv6") || nonPublicV6.check(address, "ipv6");
}

/** A local destination needs a URL for that origin or a standalone host and port. */
function userNamed(url: URL, userText: readonly string[]) {
  const host = url.hostname.replace(/\.$/, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return userText.some(text => text.split(/[\s<>"'`，。；！？、（）【】]+/).some(word => {
    const token = word.replace(/^\[[^\]]*\]\((?=https?:\/\/)|^\(+|[.,;!?)]+$/gi, "").replace(/^\p{Script=Han}+(?=https?:\/\/)/iu, "");
    // Interpret an entire URL together. A host appearing inside someone
    // else's URL is reference text and cannot authorize a local connection.
    if (/^[a-z][a-z\d+.-]*:\/\/|^\/\//i.test(token)) {
      const named = URL.parse(token, url.origin);
      return named && !named.username && !named.password && named.protocol === url.protocol &&
        named.hostname.replace(/\.$/, "") === host && named.port === url.port;
    }
    const bare = token.split(/[/?#]/, 1)[0].toLowerCase();
    return bare === `${host}:${port}` || (!url.port && (bare === host || bare === host.replace(/^\[|\]$/g, "")));
  }));
}

function privateAddressRefusal(url: URL) {
  return refuse(`${url.host} is on this computer or a private network. Such a page is read only when the user gives its address in the conversation.`);
}

function systemAddresses(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const pending = dns.lookup(host, { all: true });
  // The OS lookup itself cannot be canceled. Release the reader on abort and
  // discard the eventual result, so it can never start a request afterward.
  return new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const listener = addAbortListener(signal, () => reject(signal.reason));
    void pending.then(resolve, () => resolve([])).finally(() => listener[Symbol.dispose]());
  });
}

/** The address to connect to for a URL, checked; throws when it may not be read. */
async function checkedAddress(url: URL, userText: readonly string[], signal: AbortSignal) {
  if (!["http:", "https:"].includes(url.protocol)) throw refuse("Only http and https pages can be read.");
  if (url.username || url.password) throw refuse("Addresses with a user name or password are not read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const found = family ? [{ address: host, family }] : await systemAddresses(host, signal);
  signal.throwIfAborted();
  if (!found.length) throw failed(`The host ${url.hostname} could not be found.`);
  if (!family && found.every(entry => isFakeAddress(entry.address))) {
    if (process.env.RIA_WEB_FAKE_IP_DOH === "1") {
      const verified = await resolveCloudflareAddresses(host, signal).catch(() => []);
      signal.throwIfAborted();
      if (!verified.length || verified.some(entry => isPrivateAddress(entry.address))) {
        throw failed(tf("tools.readWebPage.fakeIpUnverified", { host }));
      }
      return { ...verified[0], requiresPermission: false };
    }
    if (!userNamed(url, userText)) throw refuse(tf("tools.readWebPage.fakeIpDisabled", { host }));
  }
  // Every address the name resolves to must be allowed, or the connection could land on a refused one.
  const requiresPermission = found.some(entry => isPrivateAddress(entry.address));
  if (requiresPermission && !userNamed(url, userText)) throw privateAddressRefusal(url);
  return { ...found[0], requiresPermission };
}

function pageDispatcher(url: URL, address: { address: string; family: number }, signal: AbortSignal) {
  const connect: Agent.Options["connect"] = {
    lookup: (_host, options, callback) => options.all
      ? callback(null, [address])
      : callback(null, address.address, address.family),
  };
  const proxy = outboundProxyOptions();
  if (!proxy) return new Agent({ connect });
  // Desktop supports HTTP(S) proxies. Other schemes would bypass the CONNECT
  // rewrite below, which is needed to pin the address on the proxy side.
  for (const value of [proxy.httpProxy, proxy.httpsProxy]) {
    if (value && !["http:", "https:"].includes(new URL(value).protocol)) {
      throw failed("Reading web pages through a proxy requires an HTTP or HTTPS proxy URL.");
    }
  }
  const ip = address.family === 6 ? `[${address.address}]` : address.address;
  const authority = `${ip}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  // Keep the original origin for NO_PROXY, Host and TLS. Only the proxy's
  // tunnel destination changes, so the proxy cannot re-resolve the hostname.
  return new EnvHttpProxyAgent({
    ...proxy, connect, proxyTunnel: true,
    clientFactory: proxyTunnelClient(signal, authority),
  });
}

async function readBody(response: Response, signal: AbortSignal) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > WEB_PAGE_LIMITS.bytes) throw failed(`The page is larger than ${WEB_PAGE_LIMITS.bytes / 1024 / 1024} MB.`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEB_PAGE_LIMITS.bytes) { await reader.cancel().catch(() => {}); throw failed(`The page is larger than ${WEB_PAGE_LIMITS.bytes / 1024 / 1024} MB.`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Fetches a page, following redirects one by one so each address is checked before it is connected to. */
export async function fetchPage(raw: string, options: { userText: readonly string[]; signal?: AbortSignal }) {
  let url: URL;
  try { url = new URL(raw); } catch { throw refuse("That is not a valid web address."); }
  const signal = AbortSignal.any([AbortSignal.timeout(WEB_PAGE_LIMITS.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const privateOrigins = new Set<string>();
  for (let hop = 0; hop <= WEB_PAGE_LIMITS.redirects; hop++) {
    let dispatcher: ReturnType<typeof pageDispatcher> | undefined;
    try {
      const checked = await checkedAddress(url, options.userText, signal);
      signal.throwIfAborted();
      if (checked.requiresPermission) privateOrigins.add(url.origin);
      dispatcher = pageDispatcher(url, checked, signal);
      const response = await undiciFetch(url, {
        redirect: "manual", signal, dispatcher,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RiA/1.0", accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/pdf;q=0.9,*/*;q=0.5" },
      }) as unknown as Response;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) throw failed("The page redirected without saying where.");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw failed(`The page answered with HTTP ${response.status}.`); }
      return { url: url.toString(), contentType: response.headers.get("content-type") ?? "", bytes: await readBody(response, signal), privateOrigins: [...privateOrigins] };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted) throw failed(options.signal?.aborted ? "Reading the page was stopped." : `The page did not answer within ${WEB_PAGE_LIMITS.timeoutMs / 1000} seconds.`);
      throw failed(`The page could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
    } finally { await dispatcher?.destroy().catch(() => {}); }
  }
  throw failed(`The page redirected more than ${WEB_PAGE_LIMITS.redirects} times.`);
}

function decode(bytes: Uint8Array, contentType: string, html = false) {
  let label = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, "");
  if (!label && html) label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(Buffer.from(bytes.subarray(0, 4096)).toString("latin1"))?.[1];
  try { return new TextDecoder(label || "utf-8").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

const turndown = () => {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  service.remove(["script", "style", "noscript", "iframe", "canvas", "form", "button", "img", "video", "audio", "picture"]);
  service.remove(node => node.nodeName.toLowerCase() === "svg");
  return service;
};

/** The main content of an HTML page as Markdown, with its links made absolute. */
export function htmlToMarkdown(html: string, url: string) {
  const { document } = parseHTML(html);
  for (const element of document.querySelectorAll("a[href]")) {
    try { element.setAttribute("href", new URL(element.getAttribute("href")!, url).toString()); } catch { element.removeAttribute("href"); }
  }
  const pageTitle = document.querySelector("title")?.textContent?.trim() ?? "";
  // Readability changes the document it reads; the body is kept first for pages it cannot handle.
  const body = document.body?.innerHTML ?? html;
  let article: ReturnType<Readability["parse"]> = null;
  try { article = new Readability(document as unknown as Document).parse(); } catch { article = null; }
  const markdown = turndown().turndown(article?.content || body).replace(/\n{3,}/g, "\n\n").trim();
  return { title: article?.title?.trim() || pageTitle || url, siteName: article?.siteName?.trim() || null, content: markdown };
}

/** A fetched page as readable text. */
export async function pageText(fetched: { url: string; contentType: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<WebPage> {
  const type = fetched.contentType.split(";")[0].trim().toLowerCase();
  const sniffHtml = !type && /^\s*(<!doctype html|<html)/i.test(Buffer.from(fetched.bytes.subarray(0, 512)).toString("latin1"));
  if (type === "text/html" || type === "application/xhtml+xml" || sniffHtml) {
    return { url: fetched.url, contentType: type || "text/html", ...htmlToMarkdown(decode(fetched.bytes, fetched.contentType, true), fetched.url) };
  }
  if (type === "application/pdf") {
    const pages = await parseDocument(fetched.bytes, "pdf", signal);
    return { url: fetched.url, title: new URL(fetched.url).pathname.split("/").pop() || fetched.url, siteName: null, contentType: type,
      content: pages.map(page => `${page.pageNumber ? `[Page ${page.pageNumber}]\n` : ""}${page.text}`).join("\n\n") };
  }
  if (type.startsWith("text/") || /^application\/([\w.+-]+\+)?(json|xml|javascript|yaml)$/.test(type)) {
    return { url: fetched.url, title: new URL(fetched.url).pathname.split("/").pop() || fetched.url, siteName: null, contentType: type, content: decode(fetched.bytes, fetched.contentType) };
  }
  throw failed(`This address returns ${type || "an unknown type of content"}, which is not a readable page.`);
}

type Cached = { page: WebPage; at: number; privateOrigins: string[] };
const cache = (): Map<string, Cached> => ((globalThis as { __riaWebPages?: Map<string, Cached> }).__riaWebPages ??= new Map());

/**
 * One part of a page: from offset, up to maxCharacters, ending at a line break
 * when one is near. The page is fetched once and kept a while, so reading on
 * does not fetch it again.
 */
export async function readWebPage(input: { url: string; offset?: number; maxCharacters?: number }, options: { userText: readonly string[]; signal?: AbortSignal }): Promise<WebPageSlice> {
  options.signal?.throwIfAborted();
  const now = Date.now();
  for (const [key, entry] of cache()) if (now - entry.at > WEB_PAGE_LIMITS.cacheMs) cache().delete(key);
  const cached = cache().get(input.url);
  let page = cached?.privateOrigins?.every(origin => userNamed(new URL(origin), options.userText)) ? cached.page : undefined;
  if (!page) {
    const fetched = await fetchPage(input.url, options);
    page = await pageText(fetched, options.signal);
    cache().set(input.url, { page, at: now, privateOrigins: fetched.privateOrigins });
    while (cache().size > WEB_PAGE_LIMITS.cachedPages) cache().delete(cache().keys().next().value!);
  }
  const total = page.content.length;
  const offset = Math.min(Math.max(0, input.offset ?? 0), total);
  const room = Math.min(input.maxCharacters ?? WEB_PAGE_LIMITS.defaultCharacters, WEB_PAGE_LIMITS.maxCharacters);
  let end = Math.min(total, offset + room);
  if (end < total) {
    const lineBreak = page.content.lastIndexOf("\n", end);
    if (lineBreak > offset + room * 0.8) end = lineBreak + 1;
  }
  return { url: page.url, title: page.title, siteName: page.siteName, contentType: page.contentType, content: page.content.slice(offset, end), offset, nextOffset: end < total ? end : null, totalCharacters: total };
}
