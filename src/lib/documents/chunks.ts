import { createHash } from "node:crypto";
import { t } from "@/lib/locale";
import { DOCUMENT_LIMITS, type DocumentPage } from "@/lib/documents/types";
import { ApiError } from "@/lib/server/api-error";
import { documentBlocks, tableChunks } from "./table-blocks";

export const DOCUMENT_INDEX_VERSION = 4;
/** Short paragraphs of one section share a chunk up to this size: a condition and its exceptions stay together. */
const MERGED_CHUNK_CHARACTERS = 800;
export const hashDocumentContent = (text: string) => createHash("sha256").update(text).digest("hex");

export function buildDocumentChunks(pages: DocumentPage[]) {
  const chunks: { chunkKey: string; ordinal: number; pageNumber: number | null; text: string; heading: string | null }[] = [];
  const occurrences = new Map<string, number>();
  const headings: string[] = [];
  const addText = (trimmed: string, pageNumber: number | null, heading: string | null) => {
    for (let start = 0; start < trimmed.length;) {
      let end = Math.min(start + 1000, trimmed.length);
      if (end < trimmed.length) {
        const boundary = Math.max(trimmed.lastIndexOf("。", end - 1), trimmed.lastIndexOf(". ", end - 1), trimmed.lastIndexOf("\n", end - 1), trimmed.lastIndexOf(" ", end - 1));
        if (boundary > start + 500) end = boundary + 1;
        if (/[\uD800-\uDBFF]/u.test(trimmed[end - 1])) end--;
      }
      const text = trimmed.slice(start, end).trim();
      if (text) {
        const hash = hashDocumentContent(`${pageNumber ?? ""}:${text}`);
        const occurrence = occurrences.get(hash) ?? 0;
        occurrences.set(hash, occurrence + 1);
        chunks.push({ chunkKey: `${hash}:${occurrence}`, ordinal: chunks.length, pageNumber, text, heading });
      }
      if (chunks.length > DOCUMENT_LIMITS.chunks) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: t("lib.documents.tooManyChunks") });
      if (end === trimmed.length) break;
      start = end - 100;
      if (/[\uDC00-\uDFFF]/u.test(trimmed[start])) start++;
    }
  };
  const run: { open: { text: string; pageNumber: number | null; heading: string | null } | null } = { open: null };
  const flush = () => { if (run.open) addText(run.open.text, run.open.pageNumber, run.open.heading); run.open = null; };
  for (const page of pages) {
    // A heading starts a new chunk, so a change in one section leaves the others' chunks
    // alone. Within a section, an edit can move the paragraphs after it between chunks.
    for (const block of documentBlocks(page.text)) {
      const paragraph = block.text;
      const trimmed = paragraph.trim();
      // Blocks split before real headings; fenced examples inside a block are text.
      const match = !block.table && /^(#{1,6})[ \t]+([^\n]+)(?:\n|$)/u.exec(trimmed);
      if (match) {
        headings.length = match[1].length - 1;
        headings.push(match[2].trim().slice(0, 200));
      }
      const heading = headings.filter(Boolean).join(" / ").slice(0, 600) || null;
      if (block.table) {
        flush();
        let texts: string[];
        try { texts = tableChunks(trimmed); }
        catch (error) { throw new ApiError({ code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "表格无法分块。" }); }
        for (const text of texts) {
          const hash = hashDocumentContent(`${page.pageNumber ?? ""}:${text}`); const occurrence = occurrences.get(hash) ?? 0;
          occurrences.set(hash, occurrence + 1);
          chunks.push({ chunkKey: `${hash}:${occurrence}`, ordinal: chunks.length, pageNumber: page.pageNumber, text, heading });
          if (chunks.length > DOCUMENT_LIMITS.chunks) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: t("lib.documents.tooManyChunks") });
        }
        continue;
      }
      // Headings and fenced code stay apart from the prose around them.
      if (match || /^\s{0,3}(`{3,}|~{3,})/u.test(trimmed)) { flush(); addText(trimmed, page.pageNumber, heading); continue; }
      if (run.open && run.open.pageNumber === page.pageNumber && run.open.heading === heading && run.open.text.length + trimmed.length + 2 <= MERGED_CHUNK_CHARACTERS) {
        run.open.text += `\n\n${trimmed}`;
      } else {
        flush();
        run.open = { text: trimmed, pageNumber: page.pageNumber, heading };
      }
    }
  }
  flush();
  if (!chunks.length) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.documents.noSearchableText") });
  return chunks;
}
