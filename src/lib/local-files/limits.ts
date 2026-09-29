import { z } from "zod";

/**
 * What a local-file operation is allowed to touch, and what it is not.
 *
 * Every number here is a ceiling the assistant cannot raise, and every one of
 * them is enforced before the work is done rather than checked afterwards.
 */
export const LOCAL_FILE_LIMITS = {
  /** Largest single file that may be read. Matches the document pipeline. */
  fileBytes: 8 * 1024 * 1024,
  /** Bytes one listing or one read may return in total. */
  readBytes: 4 * 1024 * 1024,
  /** Entries returned by one listing. */
  listEntries: 500,
  /** Directory levels walked below a grant. */
  depth: 8,
  /** Files one traversal may consider. */
  filesPerWalk: 5_000,
  /** Longest single file name accepted from the model. */
  nameLength: 200,
  /** Wall-clock ceiling for one traversal. */
  walkTimeoutMs: 15_000,
  /** Characters one read may return as text. */
  characters: 100_000,
} as const;

/** Formats the assistant may read. The same set the document import accepts. */
export const READABLE_EXTENSIONS = [".md", ".txt", ".pdf", ".docx"] as const;

/**
 * Formats the assistant may write. Deliberately narrower than what it can read:
 * producing a document is not the same as being trusted to author an executable,
 * and the first version refuses to create anything the operating system would
 * treat as a program.
 */
export const WRITABLE_EXTENSIONS = [".md", ".txt"] as const;

export const localGrantLabelSchema = z.string().min(1).max(200);

export type ReadableExtension = (typeof READABLE_EXTENSIONS)[number];
export type WritableExtension = (typeof WRITABLE_EXTENSIONS)[number];

/**
 * Why a local file was refused.
 *
 * These are stable strings rather than messages so a refusal can be reported
 * back to the model, counted per run, and asserted in tests without matching
 * on prose.
 */
export type LocalFileRefusal =
  | "network-location"
  | "blocked-location"
  | "hidden"
  | "traversal"
  | "outside-grant"
  | "symlink-escape"
  | "not-found"
  | "not-a-directory"
  | "not-a-file"
  | "unsupported-format"
  | "too-large"
  | "name-too-long";

/**
 * A refusal the caller must not retry around.
 *
 * Carries a machine-readable `reason` so the tool layer can tell the model what
 * was refused and why without leaking the refused path, and so a caller cannot
 * accidentally treat it as a transient error and try again.
 */
export class LocalFileRefused extends Error {
  readonly reason: LocalFileRefusal;

  constructor(reason: LocalFileRefusal, message: string) {
    super(message);
    this.name = "LocalFileRefused";
    this.reason = reason;
  }
}
