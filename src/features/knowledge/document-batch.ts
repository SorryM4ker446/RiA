import { DOCUMENT_LIMITS } from "@/lib/documents/types";
import { documentRequest, DocumentRequestError } from "./document-client";

/*
 * Importing several documents at once: a folder, a multiple selection, or files
 * dropped on the import card. They go one at a time, each saved as it is read,
 * so a failure or a stop leaves the earlier ones in the library. A batch has no
 * preview step: each document's extracted text can be checked once it is in.
 */

/** File types the library reads, by extension, as the single-file picker accepts them. */
export const DOCUMENT_EXTENSIONS = [".pdf", ".md", ".txt", ".docx"] as const;

export type BatchStatus = "waiting" | "importing" | "retrying" | "added" | "updated" | "unchanged" | "failed" | "skipped";
export type BatchItem = { id: string; file: File; name: string; status: BatchStatus; message?: string; retryInSeconds?: number };

/** How many times one document waits out a rate limit before it is reported as failed. */
const RATE_LIMIT_WAITS = 5;
const MAX_WAIT_SECONDS = 60;

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".")).toLowerCase();
export const isDocumentFile = (file: File) => (DOCUMENT_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));

/**
 * The items for a set of chosen files. Files the library cannot read, or that are
 * too large, are listed as skipped with the reason rather than dropped, so the
 * person sees what was left out. A folder's path is kept in the name shown.
 */
export function batchItems(files: File[], reasons: { unsupported: string; tooLarge: string }): BatchItem[] {
  return files.map((file, index) => {
    const name = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const base = { id: `${index}:${name}`, file, name };
    if (!isDocumentFile(file)) return { ...base, status: "skipped", message: reasons.unsupported };
    if (file.size > DOCUMENT_LIMITS.fileBytes) return { ...base, status: "skipped", message: reasons.tooLarge };
    return { ...base, status: "waiting" };
  });
}

function waitFor(seconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, seconds * 1000);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Imports the waiting items in order, reporting every change through `update`.
 * A rate limit is waited out as the service asks (Retry-After) rather than
 * failing the rest of the batch. Stopping leaves what is saved saved, and the
 * item in progress and those after it waiting, to be imported again later.
 */
export async function importBatch(items: BatchItem[], collection: string, signal: AbortSignal, update: (items: BatchItem[]) => void, failedMessage: string): Promise<BatchItem[]> {
  let current = items.map(item => ({ ...item }));
  const set = (id: string, change: Partial<BatchItem>) => {
    current = current.map(item => item.id === id ? { ...item, ...change } : item);
    update(current);
  };
  for (const item of items) {
    if (item.status !== "waiting" && item.status !== "failed") continue;
    for (let waits = 0; ; waits++) {
      if (signal.aborted) { set(item.id, { status: "waiting", message: undefined, retryInSeconds: undefined }); return current; }
      set(item.id, { status: "importing", message: undefined, retryInSeconds: undefined });
      const data = new FormData();
      data.set("file", item.file, item.file.name);
      if (collection.trim()) data.set("collection", collection.trim());
      try {
        const result = await documentRequest<{ change: string }>("/api/documents", { method: "POST", body: data, signal });
        set(item.id, { status: result.change === "unchanged" ? "unchanged" : result.change === "created" ? "added" : "updated" });
        break;
      } catch (error) {
        if (signal.aborted) { set(item.id, { status: "waiting" }); return current; }
        if (error instanceof DocumentRequestError && error.status === 429 && waits < RATE_LIMIT_WAITS) {
          const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(error.retryAfter) || 5));
          set(item.id, { status: "retrying", retryInSeconds: seconds });
          try { await waitFor(seconds, signal); } catch { set(item.id, { status: "waiting", retryInSeconds: undefined }); return current; }
          continue;
        }
        set(item.id, { status: "failed", message: error instanceof Error ? error.message : failedMessage, retryInSeconds: undefined });
        break;
      }
    }
  }
  return current;
}
