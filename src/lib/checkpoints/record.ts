import { db } from "@/db";
import type { FileDifference } from "@/lib/terminal/file-changes";
import { CHECKPOINT_LIMITS, putBlob, sha256 } from "./store";
import { pruneCheckpointsSoon } from "./prune";

/*
 * Rows naming what a turn changed in a workspace file, kept so the user can
 * undo the turn. Recording never fails the change it describes: the edit or
 * command already happened, and a missing row only means it cannot be undone.
 */

/** The most files one command's changes are recorded for; a command past it is undone only in part. */
export const MAX_RECORDED_CHANGES = 10_000;

type Owner = { chatId: string; runId?: string | null; grantId: string; root: string };

/** An edit by the file tool, from the content it replaced. Call before writing; the returned function records it once written. */
export async function prepareEditCheckpoint(owner: Owner, change: { path: string; before: Buffer | null; after: Buffer }) {
  const beforeHash = change.before ? sha256(change.before) : null;
  const kept = change.before && change.before.byteLength <= CHECKPOINT_LIMITS.fileBytes
    ? await putBlob(change.before, beforeHash!).then(() => true, () => false) : !change.before;
  return async () => {
    try {
      await db.fileCheckpoint.create({ data: {
        chatId: owner.chatId, runId: owner.runId ?? null, grantId: owner.grantId, root: owner.root, path: change.path, source: "edit",
        kind: change.before ? "modified" : "created", beforeHash, afterHash: sha256(change.after),
        beforeBytes: change.before?.byteLength ?? null, afterBytes: change.after.byteLength,
        restorable: kept, reason: kept ? null : "not-kept",
      } });
      pruneCheckpointsSoon();
    } catch (error) { console.error("checkpoints.record.failed", error instanceof Error ? error.message : error); }
  };
}

/** What a command changed, from the walks before and after it. */
export async function recordCommandCheckpoints(owner: Owner, differences: FileDifference[]) {
  if (!differences.length) return;
  const rows = differences.slice(0, MAX_RECORDED_CHANGES).map(({ path, kind, before, after }) => {
    const restorable = kind === "created" || !!before?.kept;
    const reason = restorable ? null : before?.skipped ?? ((before?.bytes ?? 0) > CHECKPOINT_LIMITS.fileBytes ? "too-large" : "not-read");
    return {
      chatId: owner.chatId, runId: owner.runId ?? null, grantId: owner.grantId, root: owner.root, path, source: "terminal", kind,
      beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null,
      beforeBytes: before?.bytes ?? null, afterBytes: after?.bytes ?? null, beforeGitOid: kind === "created" ? null : before?.gitOid ?? null, restorable, reason,
    };
  });
  try {
    await db.fileCheckpoint.createMany({ data: rows });
    pruneCheckpointsSoon();
  } catch (error) { console.error("checkpoints.record.failed", error instanceof Error ? error.message : error); }
}
