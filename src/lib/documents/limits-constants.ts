/**
 * How large an imported knowledge document's file may be.
 *
 * Kept dependency-free for the same reason as the media limits beside it:
 * `next.config.ts` reads it to size the proxy body limit, outside Next's own
 * module resolver. Large files are fine (scanned or illustrated PDFs, Word files
 * with images); what a document may contain once extracted (characters, pages,
 * chunks) is bounded separately in `types.ts`, since every chunk is a vector
 * that each search reads.
 */
export const DOCUMENT_UPLOAD_LIMITS = {
  fileBytes: 32 * 1024 * 1024,
  bodyBytes: 33 * 1024 * 1024,
} as const;
