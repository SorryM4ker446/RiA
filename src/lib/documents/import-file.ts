import { readImportedPages } from "@/lib/documents/import-pages";
import { hashDocumentContent } from "@/lib/documents/chunks";
import { clearDocumentOcr, queueDocumentOcr } from "@/lib/documents/ocr/runner";
import { indexDocument } from "@/lib/documents/store";
import type { DocumentFormat } from "@/lib/documents/types";
import type { DocumentRevision } from "@/lib/documents/upload";
import { ApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";

/**
 * Saves a file's text as a document, the one way both an upload and a synced
 * folder do it: the text is read, saved under the filename (a new document, or
 * the next version of the one with that name), and scanned pages are queued for
 * OCR, or any earlier reading dropped when the file now has all its text.
 * `previewHash` and `base` hold an upload to the preview it was confirmed from.
 */
export async function saveImportedDocument(input: {
  filename: string; collection?: string | null; format: DocumentFormat; bytes: Uint8Array;
  signal?: AbortSignal; previewHash?: string; base?: DocumentRevision | null;
}) {
  const { pages, pending, sourceHash } = await readImportedPages(input.bytes, input.format, input.signal);
  if (input.signal?.aborted) throw new ApiError({ code: "VALIDATION_ERROR", message: t("api.documents.importCancelled") });
  if (input.previewHash && input.previewHash !== hashDocumentContent(JSON.stringify(pages))) throw new ApiError({ code: "CONFLICT", message: t("errors.fileDiffersFromThePreviewPreviewAgain") });
  const data = await indexDocument({ filename: input.filename, collection: input.collection, format: input.format, byteSize: input.bytes.length, pages }, undefined, input.base, { textPending: pending.length > 0 });
  // Scanned pages are read in the background; a document saved with all its text needs none.
  if (pending.length && sourceHash) await queueDocumentOcr({ documentId: data.document.id, contentHash: data.document.contentHash, sourceHash, pages: pending, bytes: input.bytes });
  else await clearDocumentOcr(data.document.id);
  return data;
}
