import { z } from "zod";

export const DOCUMENT_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  bodyBytes: 9 * 1024 * 1024,
  characters: 100_000,
  pages: 200,
  chunks: 256,
  documentsPerUser: 100,
  parseTimeoutMs: 15_000,
} as const;

export const documentPageSchema = z.strictObject({ pageNumber: z.number().int().min(1).max(DOCUMENT_LIMITS.pages).nullable(), text: z.string().max(DOCUMENT_LIMITS.characters) });
export const documentPagesSchema = z.array(documentPageSchema).min(1).max(DOCUMENT_LIMITS.pages);
export type DocumentPage = z.infer<typeof documentPageSchema>;
export type DocumentFormat = "pdf" | "docx" | "md" | "txt";
export const documentIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const documentSourceSchema = z.object({
  documentId: documentIdSchema,
  chunkId: documentIdSchema,
  filename: z.string().min(1).max(180),
  pageNumber: z.number().int().positive().nullable(),
  ordinal: z.number().int().nonnegative(),
  snippet: z.string().max(1200),
});
export type DocumentSource = z.infer<typeof documentSourceSchema>;
export function documentSourceUrl(source: Pick<DocumentSource, "documentId" | "chunkId">) {
  return `/knowledge/documents/${encodeURIComponent(source.documentId)}#${encodeURIComponent(source.chunkId)}`;
}
