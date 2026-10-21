import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LOCAL_FILE_LIMITS, LocalFileRefused } from "@/lib/local-files/limits";
import { resolveProjectFile } from "@/lib/local-files/safe-path";
import { ApiError } from "@/lib/server/api-error";
import { terminalGrant } from "@/lib/terminal/runtime";
import { applyEdits, replacementRegion, unifiedDiff, type Region } from "./edits";
import { contentHash, decodeProjectText, encodeProjectText, lineCount, toWorking, type ProjectText } from "./text";

/**
 * Line-addressed reads and exact text edits for terminal-enabled folders.
 *
 * Both follow the folder's terminal permission and approval mode. An edit is
 * planned from the file as it is now, bound to that content's hash and the
 * resulting content's hash, and written only if both still hold: a file that
 * changed after the model read it, or after the user approved the diff, is
 * refused rather than merged.
 */
export const PROJECT_FILE_LIMITS = {
  readLines: 2000,
  defaultLines: 400,
  readBytes: 64 * 1024,
  lineCharacters: 2000,
  edits: 50,
  editCharacters: 1_000_000,
  diffCharacters: 60_000,
} as const;

const hashSchema = z.string().regex(/^[0-9a-f]{16}$/);
const grantIdSchema = z.string().min(1).max(200).describe("ID of a terminal-enabled folder.");
const pathSchema = z.string().min(1).max(2000).describe("File path relative to the folder, using / separators.");

export const readProjectFileInputSchema = z.strictObject({
  grantId: grantIdSchema,
  path: pathSchema,
  startLine: z.number().int().min(1).default(1).describe("First 1-based line to return."),
  lineCount: z.number().int().min(1).max(PROJECT_FILE_LIMITS.readLines).default(PROJECT_FILE_LIMITS.defaultLines),
});
export type ReadProjectFileInput = z.infer<typeof readProjectFileInputSchema>;

export const projectEditBindingSchema = z.strictObject({
  grantId: z.string().min(1), revision: z.string().min(1), cwd: z.string().min(1), path: z.string().min(1),
  beforeHash: hashSchema.nullable(), afterHash: hashSchema,
  diff: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), created: z.boolean(),
  /** Set when the file no longer matches what was proposed; execution refuses. */
  stale: z.boolean().optional(),
});
export type ProjectEditBinding = z.infer<typeof projectEditBindingSchema>;

export const editProjectFileFields = z.strictObject({
  grantId: grantIdSchema,
  path: pathSchema,
  expectedHash: hashSchema.optional().describe("Hash returned by readProjectFile for this file. Required when the file exists; omit to create a new file."),
  edits: z.array(z.strictObject({
    oldText: z.string().min(1).describe("Exact text to replace, copied from the file including indentation and line breaks."),
    newText: z.string().describe("Replacement text; empty deletes oldText."),
    replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one."),
  })).min(1).max(PROJECT_FILE_LIMITS.edits).optional(),
  content: z.string().optional().describe("Complete file content, to create a new file or rewrite an existing one."),
  binding: projectEditBindingSchema.optional(),
});
export const editProjectFileInputSchema = editProjectFileFields.refine(input => (input.edits === undefined) !== (input.content === undefined), "Provide either edits or content, not both.");
export type EditProjectFileInput = z.infer<typeof editProjectFileInputSchema>;

const refuse = (message: string) => new ApiError({ code: "CONFLICT", message });
const invalid = (message: string) => new ApiError({ code: "VALIDATION_ERROR", message });

/** File tools are a way of using terminal access, so they require exactly that. */
async function projectGrant(grantId: string) {
  return terminalGrant(grantId);
}

async function readCurrent(absolutePath: string) {
  const bytes = await readFile(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!bytes) return null;
  if (bytes.byteLength > LOCAL_FILE_LIMITS.fileBytes) throw new LocalFileRefused("too-large", "This file is larger than the limit for file tools; use the terminal.");
  return { bytes, hash: contentHash(bytes), file: decodeProjectText(bytes) };
}

export async function readProjectFile(input: ReadProjectFileInput, signal?: AbortSignal) {
  const grant = await projectGrant(input.grantId);
  const target = await resolveProjectFile(grant, input.path, "read");
  signal?.throwIfAborted();
  const current = await readCurrent(target.absolutePath);
  if (!current) throw new LocalFileRefused("not-found", "That file does not exist.");
  const all = current.file.text.split("\n");
  const totalLines = lineCount(current.file.text);
  const lines: { line: number; text: string }[] = [];
  let bytes = 0, nextLine: number | null = null;
  for (let index = input.startLine - 1; index < totalLines; index++) {
    if (lines.length >= input.lineCount) { nextLine = index + 1; break; }
    const raw = all[index];
    const text = raw.length > PROJECT_FILE_LIMITS.lineCharacters ? `${raw.slice(0, PROJECT_FILE_LIMITS.lineCharacters)} … [line truncated; copy oldText only from untruncated lines]` : raw;
    bytes += Buffer.byteLength(text) + 1;
    if (bytes > PROJECT_FILE_LIMITS.readBytes && lines.length) { nextLine = index + 1; break; }
    lines.push({ line: index + 1, text });
  }
  return { grantId: grant.id, path: target.relativePath, hash: current.hash, bytes: current.bytes.byteLength, totalLines, eol: current.file.eol, bom: current.file.bom, startLine: input.startLine, lines, nextLine };
}

type Plan = { target: Awaited<ReturnType<typeof resolveProjectFile>>; beforeHash: string | null; after: Buffer; afterHash: string; diff: string; added: number; removed: number; created: boolean; beforeStats: { bytes: number; lines: number } | null; afterLines: number };

/** The edit as it would apply to the file now. Throws, with what to do next, when it cannot. */
async function planEdit(input: EditProjectFileInput, grant: { realPath: string }): Promise<Plan> {
  const target = await resolveProjectFile(grant, input.path, "write");
  const size = (input.content?.length ?? 0) + (input.edits ?? []).reduce((sum, edit) => sum + edit.oldText.length + edit.newText.length, 0);
  if (size > PROJECT_FILE_LIMITS.editCharacters) throw invalid("This edit is larger than file tools accept; split it or use the terminal.");
  const current = await readCurrent(target.absolutePath);
  if (current && !input.expectedHash) throw refuse(`${target.relativePath} already exists. Read it with readProjectFile and pass its hash as expectedHash.`);
  if (!current && input.expectedHash) throw refuse(`${target.relativePath} no longer exists. Read the folder again before editing.`);
  if (current && input.expectedHash !== current.hash) throw refuse(`${target.relativePath} changed since it was read (current hash ${current.hash}). Read it again and redo the edit against the current content.`);
  if (!current && input.edits) throw refuse(`${target.relativePath} does not exist. Use content to create it.`);
  let next: ProjectText, regions: Region[];
  if (current && input.edits) {
    const edits = input.edits.map(edit => ({ ...edit, oldText: toWorking(edit.oldText, current.file.eol), newText: toWorking(edit.newText, current.file.eol) }));
    const applied = applyEdits(current.file.text, edits);
    next = { ...current.file, text: applied.text };
    regions = applied.regions;
  } else {
    // An existing file keeps its own line endings and BOM; a new file is written exactly as given.
    const text = current ? toWorking(input.content!, current.file.eol) : input.content!;
    next = current ? { ...current.file, text } : { text, eol: "mixed", bom: false };
    regions = current ? [replacementRegion(current.file.text, text)] : [];
  }
  if (current && next.text === current.file.text) throw invalid("This edit makes no change to the file.");
  const after = encodeProjectText(next);
  if (after.byteLength > LOCAL_FILE_LIMITS.fileBytes) throw invalid("The edited file would be larger than file tools accept; use the terminal.");
  const { diff, added, removed } = unifiedDiff(target.relativePath, current ? current.file.text : null, next.text, regions, PROJECT_FILE_LIMITS.diffCharacters);
  return { target, beforeHash: current?.hash ?? null, after, afterHash: contentHash(after), diff, added, removed, created: !current,
    beforeStats: current ? { bytes: current.bytes.byteLength, lines: lineCount(current.file.text) } : null, afterLines: lineCount(next.text) };
}

/**
 * Bind an edit before it is shown for approval. The preview is always computed
 * here from the file on disk; a binding carried in the input is kept only to
 * remember what was approved, so a resumed approval for content that has since
 * changed is marked stale instead of being re-approved silently.
 */
export async function bindProjectEdit(input: unknown) {
  const parsed = editProjectFileInputSchema.parse(input);
  const grant = await projectGrant(parsed.grantId);
  const plan = await planEdit(parsed, grant);
  const current: ProjectEditBinding = { grantId: grant.id, revision: grant.updatedAt.toISOString(), cwd: grant.realPath, path: plan.target.relativePath,
    beforeHash: plan.beforeHash, afterHash: plan.afterHash, diff: plan.diff, added: plan.added, removed: plan.removed, created: plan.created };
  const previous = parsed.binding;
  const stale = previous && (previous.grantId !== current.grantId || previous.revision !== current.revision || previous.cwd !== current.cwd
    || previous.path !== current.path || previous.beforeHash !== current.beforeHash || previous.afterHash !== current.afterHash);
  const binding = stale ? { ...previous, stale: true } : current;
  Object.assign(input as object, { ...parsed, binding });
  return { ...parsed, binding };
}

const locks = new Map<string, Promise<unknown>>();
/** Serialize edits to one file inside this service; other writers are caught by the hash check. */
async function withFileLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  locks.set(key, run);
  try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
}

async function writeAtomically(absolutePath: string, bytes: Buffer) {
  const temporary = path.join(/*turbopackIgnore: true*/ path.dirname(absolutePath), `.ria-edit-${randomUUID()}.tmp`);
  const mode = (await stat(absolutePath).catch(() => null))?.mode;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (mode !== undefined && process.platform !== "win32") await chmod(temporary, mode);
    await rename(temporary, absolutePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") throw refuse("The file is locked or read-only; close programs using it or use the terminal.");
    throw error;
  }
}

export async function applyProjectEdit(input: EditProjectFileInput, signal?: AbortSignal) {
  const binding = input.binding;
  if (!binding) throw refuse("This edit was not prepared for execution; propose it again.");
  if (binding.stale) throw refuse(`${binding.path} changed after this edit was proposed. Read it again and propose a new edit.`);
  const grant = await projectGrant(input.grantId);
  if (grant.id !== binding.grantId || grant.realPath !== binding.cwd || grant.updatedAt.toISOString() !== binding.revision) {
    throw refuse("The folder's terminal permission changed; propose the edit again.");
  }
  const target = await resolveProjectFile(grant, input.path, "write");
  return withFileLock(target.absolutePath.toLowerCase(), async () => {
    signal?.throwIfAborted();
    const plan = await planEdit(input, grant).catch(error => {
      // The approved preview no longer describes this file.
      if (error instanceof ApiError && error.code === "CONFLICT") throw refuse(`${binding.path} changed after this edit was approved. Read it again and propose a new edit.`);
      throw error;
    });
    if (plan.beforeHash !== binding.beforeHash || plan.afterHash !== binding.afterHash || plan.target.relativePath !== binding.path) {
      throw refuse(`${binding.path} changed after this edit was approved. Read it again and propose a new edit.`);
    }
    signal?.throwIfAborted();
    await writeAtomically(plan.target.absolutePath, plan.after);
    return {
      grantId: grant.id, cwd: grant.realPath, path: plan.target.relativePath, created: plan.created,
      beforeHash: plan.beforeHash, hash: plan.afterHash, added: plan.added, removed: plan.removed, diff: plan.diff,
      fileChanges: { complete: true, files: [{ path: plan.target.relativePath, kind: plan.created ? "created" as const : "modified" as const,
        before: plan.beforeStats, after: { bytes: plan.after.byteLength, lines: plan.afterLines } }] },
    };
  });
}
export type ProjectEditResult = Awaited<ReturnType<typeof applyProjectEdit>>;
