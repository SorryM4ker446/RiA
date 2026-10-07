import { createHash } from "node:crypto";
import { t } from "@/lib/locale";
import { DOCUMENT_LIMITS, type DocumentPage } from "@/lib/documents/types";
import { ApiError } from "@/lib/server/api-error";

export const DOCUMENT_INDEX_VERSION = 2;
export const hashDocumentContent = (text: string) => createHash("sha256").update(text).digest("hex");

export function buildDocumentChunks(pages: DocumentPage[]) {
  const chunks: { chunkKey: string; ordinal: number; pageNumber: number | null; text: string; heading: string | null }[] = [];
  const occurrences = new Map<string, number>();
  const headings: string[] = [];
  for (const page of pages) {
    // Paragraph boundaries keep unaffected chunks stable when another paragraph changes.
    for (const paragraph of page.text.split(/\n\s*\n|\n(?=#{1,6}\s)/u)) {
      const trimmed = paragraph.trim();
      for (const match of trimmed.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
        headings.length = match[1].length - 1;
        headings.push(match[2].trim().slice(0, 200));
      }
      const heading = headings.filter(Boolean).join(" / ").slice(0, 600) || null;
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
          chunks.push({ chunkKey: `${hash}:${occurrence}`, ordinal: chunks.length, pageNumber: page.pageNumber, text, heading });
        }
        if (chunks.length > DOCUMENT_LIMITS.chunks) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: t("lib.documents.tooManyChunks") });
        if (end === trimmed.length) break;
        start = end - 100;
        if (/[\uDC00-\uDFFF]/u.test(trimmed[start])) start++;
      }
    }
  }
  if (!chunks.length) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.documents.noSearchableText") });
  return chunks;
}
