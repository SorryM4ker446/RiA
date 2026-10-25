import { db } from "@/db";
import { parseDocument } from "@/lib/documents/parser";
import { hashDocumentContent } from "@/lib/documents/chunks";
import { documentPagesSchema, type DocumentFormat, type DocumentPage } from "@/lib/documents/types";
import { ApiError } from "@/lib/server/api-error";
import { htmlDocument, parseContent, plainText, exportCsp } from "./ast";
import { wordDocument } from "./docx";
import { conversionNotes, contentTypes, exportFilename, exportRequestSchema, processorTextSchema, type ProcessedDocument } from "./schema";

function processed(filename: string, format: string, pages: DocumentPage[]): ProcessedDocument {
  const content = processorTextSchema.parse(pages.map(page => page.text).join("\n\n"));
  return { filename, format, pages, content, syntax: ["md", "docx"].includes(format) ? "markdown" : "plain", characterCount: content.length, contentHash: hashDocumentContent(JSON.stringify(pages)), notes: conversionNotes };
}
export async function processUpload(input: { filename: string; format: DocumentFormat; file: File }, signal?: AbortSignal) {
  const pages = await parseDocument(new Uint8Array(await input.file.arrayBuffer()), input.format, signal, { escapeMarkdown: true });
  signal?.throwIfAborted(); return processed(input.filename, input.format, pages);
}
export async function loadProcessorDocument(id: string, options: { collections?: string[]; version?: string } = {}) {
  const row = await db.knowledgeDocument.findUnique({ where: { id }, select: { id: true, filename: true, format: true, pages: true, contentHash: true, collection: true } });
  if (!row || (options.collections?.length && !options.collections.includes(row.collection ?? ""))) throw new ApiError({ code: "NOT_FOUND", message: "文档不存在，或不在当前助理可用的主题中。" });
  if (options.version && row.contentHash !== options.version) throw new ApiError({ code: "CONFLICT", message: "文档已更新，请重新转换后下载。" });
  return { ...processed(row.filename, row.format, documentPagesSchema.parse(row.pages)), source: { id: row.id, contentHash: row.contentHash } };
}
export async function exportDocument(raw: unknown, signal?: AbortSignal) {
  const input = exportRequestSchema.parse(raw);
  signal?.throwIfAborted();
  const tree = parseContent(input.content, input.syntax);
  const text = input.format === "md" ? input.syntax === "markdown" ? input.content : input.content.replace(/([\\`*_{}\[\]<>()#+\-.!|~])/g, "\\$1")
    : input.format === "txt" ? input.syntax === "plain" ? input.content : plainText(tree.root, tree).trimEnd()
    : input.format === "html" ? htmlDocument(tree, input.filename, input.syntax) : null;
  const bytes = text === null ? await wordDocument(tree, signal) : new TextEncoder().encode(text);
  signal?.throwIfAborted();
  if (bytes.byteLength > 8 * 1024 * 1024) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "导出结果超过 8 MiB，请拆分文档。" });
  return { bytes, filename: exportFilename(input.filename, input.format), contentType: contentTypes[input.format], format: input.format };
}
export function exportResponse(result: Awaited<ReturnType<typeof exportDocument>>) {
  return new Response(new Uint8Array(result.bytes), { headers: { "Content-Type": result.contentType, "Content-Length": String(result.bytes.byteLength), "Content-Disposition": `attachment; filename="document.${result.format}"; filename*=UTF-8''${encodeURIComponent(result.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...(result.format === "html" ? { "Content-Security-Policy": exportCsp } : {}) } });
}
