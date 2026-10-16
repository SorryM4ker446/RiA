import { getApiErrorMessage } from "@/lib/api-error-message";
import { t } from "@/lib/locale";

export type DocumentSummary = { id: string; filename: string; contentHash: string; collection?: string | null; characterCount: number; indexedAt: string; indexVersion?: number; _count: { chunks: number };
  semantic?: { indexed: number; total: number; lexicalCurrent?: boolean; stale?: number; differentModel?: number; invalid?: number; modelRef: { providerId: string; modelId: string } | null } };
export type DocumentPreview = { filename: string; collection: string | null; previewHash: string; base: { id: string; contentHash: string; collection: string | null } | null;
  characterCount: number; notes: string[]; chunks: { text: string; ordinal: number; heading: string | null; pageNumber: number | null }[] };

export class DocumentRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null) { super(message); }
}
export async function documentRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json();
  if (!response.ok) throw new DocumentRequestError(getApiErrorMessage(payload, t("documents.requestFailed")), response.status, response.headers.get("Retry-After"));
  return payload.data as T;
}
