import { getApiErrorMessage } from "@/lib/api-error-message";
import { t } from "@/lib/locale";
import type { DocumentSource } from "@/lib/documents/types";

export type DocumentSummary = { id: string; filename: string; contentHash: string; collection?: string | null; characterCount: number; indexedAt: string; indexVersion?: number; _count: { chunks: number };
  semantic?: { indexed: number; total: number; lexicalCurrent?: boolean; stale?: number; differentModel?: number; invalid?: number; modelRef: { providerId: string; modelId: string } | null };
  /** Scanned pages still being read by OCR; absent once every page is read. */
  ocr?: { status: "pending" | "running" | "failed" | "done"; done: number; total: number; error: string | null } };
export type DocumentPreview = { filename: string; collection: string | null; previewHash: string; base: { id: string; contentHash: string; collection: string | null } | null;
  characterCount: number; notes: string[]; chunks: { text: string; ordinal: number; heading: string | null; pageNumber: number | null }[] };

export type DocumentIndexing = { running: boolean; failed: string | null; failure?: { message: string; fix?: "apiKeys" | "models" } };
/** The library with how far the automatic indexing has got. */
export async function listDocuments(signal?: AbortSignal): Promise<{ documents: DocumentSummary[]; indexing: DocumentIndexing }> {
  const response = await fetch("/api/documents", { cache: "no-store", signal });
  const payload = await response.json();
  if (!response.ok) throw new DocumentRequestError(getApiErrorMessage(payload, t("documents.requestFailed")), response.status, response.headers.get("Retry-After"));
  return { documents: payload.data, indexing: payload.indexing ?? { running: false, failed: null } };
}

export class DocumentRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null) { super(message); }
}
export async function documentRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json();
  if (!response.ok) throw new DocumentRequestError(getApiErrorMessage(payload, t("documents.requestFailed")), response.status, response.headers.get("Retry-After"));
  return payload.data as T;
}

/**
 * Searches the content of the imported documents. Retrieval may embed the query with the configured
 * model, so callers run it on an explicit request (Enter or a click), never on every keystroke.
 */
export async function searchDocumentContent(query: string, collections: string[], signal?: AbortSignal): Promise<{ sources: DocumentSource[]; diagnostics: unknown }> {
  const response = await fetch("/api/documents/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, collections }), signal });
  const payload = await response.json();
  if (!response.ok) throw new DocumentRequestError(getApiErrorMessage(payload, t("documents.requestFailed")), response.status, response.headers.get("Retry-After"));
  return { sources: payload.data, diagnostics: payload.diagnostics };
}
