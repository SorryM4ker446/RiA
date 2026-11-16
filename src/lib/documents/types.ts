import { z } from "zod";
import { DOCUMENT_UPLOAD_LIMITS } from "./limits-constants";

export const DOCUMENT_LIMITS = {
  ...DOCUMENT_UPLOAD_LIMITS,
  // What a document holds once extracted stays bounded: every chunk is a vector
  // that each search by meaning reads, so these grow with a vector index, not
  // with the file size.
  characters: 100_000,
  // Pages cost nothing at search time; a long, mostly visual PDF fits as long as its text does.
  pages: 1000,
  chunks: 256,
  /** Decompressed data a Word archive may hold: images and styles included, so well above its text. */
  expandedBytes: 64 * 1024 * 1024,
  documentsPerUser: 100,
  // PDF.js can take several seconds to cold-start on a constrained CI or
  // Windows machine before it begins reading a document, and a large one takes longer.
  parseTimeoutMs: 90_000,
  /** How long worker cleanup may block the response before it is abandoned. */
  terminateGraceMs: 2_000,
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
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  collection: z.string().max(40).nullable().optional(),
  retrieval: z.enum(["local-keyword", "semantic", "hybrid", "neighbor"]).optional(),
  heading: z.string().max(600).nullable().optional(),
  semanticScore: z.number().min(0).max(1.000001).optional(),
  lexicalScore: z.number().nonnegative().optional(),
  anchorChunkId: documentIdSchema.optional(),
  citationStatus: z.enum(["cited", "not-cited"]).optional(),
  matchedTerms: z.array(z.string().max(100)).max(16).optional(),
});
export type DocumentSource = z.infer<typeof documentSourceSchema>;
export function documentSourceUrl(source: Pick<DocumentSource, "documentId" | "chunkId" | "contentHash">) {
  return `/knowledge/documents/${encodeURIComponent(source.documentId)}${source.contentHash ? `?version=${source.contentHash}` : ""}#${encodeURIComponent(source.chunkId)}`;
}

export type DocumentReferenceStatus = { chunkId: string; status: "current" | "changed" | "deleted" | "unverified" };

export function markDocumentCitations(sources: DocumentSource[], answer: string): DocumentSource[] {
  const urls = new Set([...answer.matchAll(/\[[^\]]+\]\(([^\s)]+)\)/gu)].map(match => match[1]));
  return sources.map(source => ({ ...source, citationStatus: urls.has(documentSourceUrl(source)) ? "cited" : "not-cited" }));
}
