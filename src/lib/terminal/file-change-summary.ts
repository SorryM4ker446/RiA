import { terminalFileChangesSchema, type TerminalFileChange } from "./schema";

export type EditedFile = TerminalFileChange & { grantId: string; cwd: string };

/** Merge observations from this reply without carrying a second persisted list. */
export function collectEditedFiles(parts: readonly unknown[]): { files: EditedFile[]; complete: boolean } {
  const files = new Map<string, EditedFile>();
  let complete = true;
  for (const value of parts) {
    if (!value || typeof value !== "object") continue;
    const part = value as { type?: unknown; state?: unknown; output?: { grantId?: unknown; cwd?: unknown; fileChanges?: unknown } };
    // Exact edits report their changes in the same shape as terminal commands.
    if ((part.type !== "tool-runTerminalCommand" && part.type !== "tool-editProjectFile") || part.state !== "output-available" || !part.output) continue;
    const { grantId, cwd } = part.output;
    if (typeof grantId !== "string" || typeof cwd !== "string" || !part.output.fileChanges) continue;
    const parsed = terminalFileChangesSchema.safeParse(part.output.fileChanges);
    if (!parsed.success) { complete = false; continue; }
    complete &&= parsed.data.complete;
    for (const change of parsed.data.files) {
      const key = `${grantId}:${cwd}:${change.path}`;
      const previous = files.get(key);
      const before = previous ? previous.before : change.before;
      files.delete(key);
      if (!before && !change.after) continue;
      files.set(key, { ...change, before, kind: !before ? "created" : !change.after ? "deleted" : "modified", grantId, cwd });
    }
  }
  return { files: [...files.values()].reverse(), complete };
}
