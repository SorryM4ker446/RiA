import { parseDocumentForImport } from "@/lib/documents/parser";
import { reusableOcrText, sourceDigest, withOcrText } from "@/lib/documents/ocr/runner";
import type { DocumentFormat, DocumentPage } from "@/lib/documents/types";

/**
 * A file's pages as the knowledge base saves them, shared by the import preview
 * and the import itself so both describe the same text. A scanned PDF's pages
 * are listed in `pending`, to be read after the import; pages the very same file
 * already had read in an earlier import come back with that text instead.
 */
export async function readImportedPages(bytes: Uint8Array, format: DocumentFormat, signal?: AbortSignal): Promise<{ pages: DocumentPage[]; pending: number[]; sourceHash: string | null }> {
  const { pages, ocrPages } = await parseDocumentForImport(bytes, format, signal, { allowTextless: true });
  if (!ocrPages.length) return { pages, pending: [], sourceHash: null };
  const sourceHash = sourceDigest(bytes);
  const known = await reusableOcrText(sourceHash) ?? {};
  const reused = Object.fromEntries(ocrPages.filter(page => Object.hasOwn(known, String(page))).map(page => [String(page), known[String(page)]]));
  return { pages: withOcrText(pages, reused), pending: ocrPages.filter(page => !Object.hasOwn(reused, String(page))), sourceHash };
}
