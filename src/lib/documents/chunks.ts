import { createHash } from "node:crypto";
import { DOCUMENT_LIMITS, type DocumentPage } from "@/lib/documents/types";
import { ApiError } from "@/lib/server/api-error";

export const DOCUMENT_INDEX_VERSION = 1;
export const hashDocumentContent = (text: string) => createHash("sha256").update(text).digest("hex");

export function buildDocumentChunks(pages: DocumentPage[]) {
  const chunks: { chunkKey: string; ordinal: number; pageNumber: number | null; text: string }[] = [];
  const occurrences = new Map<string, number>();
  for (const page of pages) {
    // Paragraph boundaries keep unaffected chunks stable when another paragraph changes.
    for (const paragraph of page.text.split(/\n\s*\n/u)) {
      const trimmed = paragraph.trim();
      for (let start = 0; start < trimmed.length;) {
        let end = Math.min(start + 1000, trimmed.length);
        if (end < trimmed.length) {
          const boundary = Math.max(trimmed.lastIndexOf("。", end - 1), trimmed.lastIndexOf(". ", end - 1), trimmed.lastIndexOf("\n", end - 1), trimmed.lastIndexOf(" ", end - 1));
          if (boundary > start + 500) end = boundary + 1;
          if (/[\uD800-\uDBFF]/u.test(trimmed[end - 1])) end--;
        }
        const text = trimmed.slice(start, end).trim();
        if (text) {
          const hash = hashDocumentContent(`${page.pageNumber ?? ""}:${text}`);
          const occurrence = occurrences.get(hash) ?? 0;
          occurrences.set(hash, occurrence + 1);
          chunks.push({ chunkKey: `${hash}:${occurrence}`, ordinal: chunks.length, pageNumber: page.pageNumber, text });
        }
        if (chunks.length > DOCUMENT_LIMITS.chunks) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "文档片段过多，请拆分文档后导入。" });
        if (end === trimmed.length) break;
        start = end - 100;
        if (/[\uDC00-\uDFFF]/u.test(trimmed[start])) start++;
      }
    }
  }
  if (!chunks.length) throw new ApiError({ code: "VALIDATION_ERROR", message: "文档没有可检索的文本；扫描 PDF 请先进行 OCR。" });
  return chunks;
}
