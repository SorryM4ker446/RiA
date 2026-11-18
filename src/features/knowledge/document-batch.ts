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
/** `name` is what the list shows; `documentName` is the name the document is saved under. */
export type BatchItem = { id: string; file: File; name: string; documentName: string; status: BatchStatus; message?: string; retryInSeconds?: number };

/** How many times one document waits out a rate limit before it is reported as failed. */
const RATE_LIMIT_WAITS = 5;
const MAX_WAIT_SECONDS = 60;

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".")).toLowerCase();
export const isDocumentFile = (file: File) => (DOCUMENT_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));

/** Between the folders of a path within the chosen folder, in a document name (which cannot hold a slash). */
export const PATH_SEPARATOR = " › ";
/** The longest document name the library accepts. */
const DOCUMENT_NAME_LIMIT = 180;

/**
 * The items for a set of chosen files. Files the library cannot read, or that are
 * too large, are listed as skipped with the reason rather than dropped, so the
 * person sees what was left out. A folder's path is kept in the name shown.
 *
 * A document is saved under its file name, and a name already in the library is
 * updated. Files of a folder that share a name (`finance/readme.md`,
 * `hr/readme.md`) would overwrite one another, so those are named by their path
 * within the folder instead (`finance › readme.md`); importing the folder again
 * gives the same names. Files sharing a name with no folder path to tell them
 * apart are skipped after the first.
 */
export function batchItems(files: File[], reasons: { unsupported: string; tooLarge: string; sameName: string; nameTooLong: string }): BatchItem[] {
  const pathOf = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
  const readable = (file: File) => isDocumentFile(file) && file.size <= DOCUMENT_LIMITS.fileBytes;
  const sharing = new Map<string, number>();
  for (const file of files) if (readable(file)) sharing.set(file.name, (sharing.get(file.name) ?? 0) + 1);
  const seen = new Set<string>();
  return files.map((file, index) => {
    const name = pathOf(file) || file.name;
    const base = { id: `${index}:${name}`, file, name, documentName: file.name };
    if (!isDocumentFile(file)) return { ...base, status: "skipped", message: reasons.unsupported };
    if (file.size > DOCUMENT_LIMITS.fileBytes) return { ...base, status: "skipped", message: reasons.tooLarge };
    if ((sharing.get(file.name) ?? 0) < 2) return { ...base, status: "waiting" };
    // The first part of a folder's path is the chosen folder itself; the rest tells the files apart.
    const inside = pathOf(file).split("/").slice(1);
    if (inside.length < 2) {
      if (seen.has(file.name)) return { ...base, status: "skipped", message: reasons.sameName };
      seen.add(file.name);
      return { ...base, status: "waiting" };
    }
    const documentName = inside.join(PATH_SEPARATOR);
    if (documentName.length > DOCUMENT_NAME_LIMIT) return { ...base, documentName, status: "skipped", message: reasons.nameTooLong };
    return { ...base, documentName, status: "waiting" };
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
      data.set("file", item.file, item.documentName);
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
