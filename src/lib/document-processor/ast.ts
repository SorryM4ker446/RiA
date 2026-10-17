import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root, RootContent, PhrasingContent, Definition } from "mdast";
import { ApiError } from "@/lib/server/api-error";
import type { ContentSyntax } from "./schema";

export type DocumentNode = Root | RootContent | PhrasingContent;
export type DocumentTree = { root: Root; definitions: Map<string, Definition> };
export const escapeMarkup = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export function parseContent(content: string, syntax: ContentSyntax): DocumentTree {
  const root: Root = syntax === "markdown" ? fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) : { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: content }] }] };
  let count = 0; const definitions = new Map<string, Definition>();
  function visit(node: DocumentNode, depth = 0) {
    if (++count > 20_000 || depth > 32 || (node.type === "table" && (node.children.length > 2000 || node.children.some(row => row.children.length > 64)))) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "文档结构过于复杂，请拆分后再导出。" });
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if ("children" in node) for (const child of node.children) visit(child, depth + 1);
  }
  visit(root); return { root, definitions };
}
export function linkDestination(node: DocumentNode, tree: DocumentTree) {
  return "url" in node ? node.url : "identifier" in node ? tree.definitions.get(node.identifier)?.url : undefined;
}
export function plainText(node: DocumentNode, tree: DocumentTree): string {
  const children = () => "children" in node ? node.children.map(child => plainText(child, tree)).join("") : "";
  switch (node.type) {
    case "text": case "inlineCode": case "html": return node.value;
    case "code": return node.value + "\n\n";
    case "root": case "blockquote": case "listItem": return children();
    case "footnoteDefinition": return `[^${node.identifier}]: ${children()}`;
    case "heading": case "paragraph": return children() + "\n\n";
    case "break": return "\n";
    case "thematicBreak": return "\n———\n\n";
    case "definition": return "";
    case "link": case "linkReference": { const text = children(), url = linkDestination(node, tree); return url && url !== text ? `${text} (${url})` : text; }
    case "image": case "imageReference": return `[图片：${node.alt ?? ""}]${linkDestination(node, tree) ? ` (${linkDestination(node, tree)})` : ""}`;
    case "footnoteReference": return `[^${node.identifier}]`;
    case "list": return node.children.map((item, index) => `${node.ordered ? `${(node.start ?? 1) + index}.` : "•"} ${item.checked == null ? "" : item.checked ? "[x] " : "[ ] "}${plainText(item, tree).trim().replace(/\n/g, "\n  ")}`).join("\n") + "\n\n";
    case "table": return node.children.map(row => row.children.map(cell => plainText(cell, tree).replace(/\n/g, " ")).join("\t")).join("\n") + "\n\n";
    default: return children();
  }
}
function safeLink(value: string | undefined) {
  if (!value || /[\x00-\x20]/u.test(value)) return null;
  try { return ["https:", "http:", "mailto:"].includes(new URL(value).protocol) ? escapeMarkup(value) : null; } catch { return null; }
}
export function htmlBody(tree: DocumentTree): string {
  function render(node: DocumentNode): string {
    const children = () => "children" in node ? node.children.map(child => render(child)).join("") : "";
    switch (node.type) {
      case "root": return children();
      case "text": case "html": return escapeMarkup(node.value);
      case "paragraph": return `<p>${children()}</p>`;
      case "heading": return `<h${node.depth}>${children()}</h${node.depth}>`;
      case "strong": return `<strong>${children()}</strong>`;
      case "emphasis": return `<em>${children()}</em>`;
      case "delete": return `<del>${children()}</del>`;
      case "inlineCode": return `<code>${escapeMarkup(node.value)}</code>`;
      case "code": return `<pre><code>${escapeMarkup(node.value)}</code></pre>`;
      case "blockquote": return `<blockquote>${children()}</blockquote>`;
      case "thematicBreak": return "<hr>";
      case "break": return "<br>";
      case "list": return node.ordered ? `<ol start="${node.start ?? 1}">${children()}</ol>` : `<ul>${children()}</ul>`;
      case "listItem": return `<li>${node.checked == null ? "" : node.checked ? "☑ " : "☐ "}${children()}</li>`;
      case "table": return `<div class="table-wrap"><table>${node.children.map((row, index) => `<${index ? "tbody" : "thead"}><tr>${row.children.map(cell => `<${index ? "td" : "th"}>${render(cell)}</${index ? "td" : "th"}>`).join("")}</tr></${index ? "tbody" : "thead"}>`).join("")}</table></div>`;
      case "link": case "linkReference": { const url = safeLink(linkDestination(node, tree)); return url ? `<a href="${url}" rel="noreferrer noopener">${children()}</a>` : children(); }
      case "image": case "imageReference": return `<span>${escapeMarkup(plainText(node, tree))}</span>`;
      case "definition": return "";
      case "footnoteDefinition": return `<aside>注释 ${escapeMarkup(node.identifier)}：${children()}</aside>`;
      case "footnoteReference": return `<sup>[${escapeMarkup(node.identifier)}]</sup>`;
      default: return children();
    }
  }
  return render(tree.root);
}
export const exportCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";
export function htmlDocument(tree: DocumentTree, title: string, syntax: ContentSyntax) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeMarkup(exportCsp)}"><title>${escapeMarkup(title)}</title><style>html{background:#fff}body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:850px;margin:40px auto;padding:0 24px;line-height:1.8;color:#252525;overflow-wrap:anywhere}p{white-space:${syntax === "plain" ? "pre-wrap" : "normal"}}h1,h2,h3,h4,h5,h6{line-height:1.35;margin-top:1.5em}pre{white-space:pre-wrap;background:#f4f4f5;padding:16px;border-radius:8px}code{font-family:Consolas,monospace}blockquote{margin-left:0;padding-left:18px;border-left:3px solid #ddd;color:#555}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f4f4f5}a{color:#255daa}@media print{body{max-width:none;margin:0}pre,tr{break-inside:avoid}thead{display:table-header-group}}</style></head><body>${htmlBody(tree)}</body></html>`;
}
