import { db } from "@/db";
import { dropKeptSnapshotHashes, keptSnapshotHashes } from "@/lib/terminal/file-changes";
import { CHECKPOINT_LIMITS, listBlobs, removeBlob, storeHasRoom, storeLimit } from "./store";

/*
 * Keeps the checkpoint store within its limit (the user's, else 2 GiB): rows
 * older than the retention go, content nothing needs goes, and past the limit
 * copies kept only in case a file changes later go first, then the content
 * needed by the oldest changes (those are then marked as no longer undoable,
 * with the reason). New copies are refused while the store is full rather than
 * pushing anything out, so a full store does not keep re-reading and dropping.
 * Runs at start-up and shortly after new checkpoints, one pass at a time.
 */

/** Content written this recently is left alone: its row or folder view may still be on the way. */
const GRACE_MS = 10 * 60_000;
const DELAY_MS = 60_000;

type State = { timer?: ReturnType<typeof setTimeout>; running?: Promise<void> };
const state = () => ((globalThis as { __riaCheckpointPrune?: State }).__riaCheckpointPrune ??= {});

export function pruneCheckpointsSoon() {
  const current = state();
  if (current.timer) return;
  current.timer = setTimeout(() => { current.timer = undefined; void pruneCheckpoints().catch(() => console.error("checkpoints.prune.failed")); }, DELAY_MS);
  current.timer.unref?.();
}

export function pruneCheckpoints(now = Date.now()): Promise<void> {
  const current = state();
  current.running ??= prune(now).finally(() => { current.running = undefined; });
  return current.running;
}

async function prune(now: number) {
  await db.fileCheckpoint.deleteMany({ where: { createdAt: { lt: new Date(now - CHECKPOINT_LIMITS.retentionMs) } } });
  // When each kept content was last needed: by an undoable change, or by a folder's current view.
  const neededAt = new Map<string, number>();
  // Content git gives back needs no copy.
  const rows = await db.fileCheckpoint.findMany({ where: { undoneAt: null, restorable: true, beforeHash: { not: null }, beforeGitOid: null }, select: { beforeHash: true, createdAt: true } });
  for (const row of rows) neededAt.set(row.beforeHash!, Math.max(neededAt.get(row.beforeHash!) ?? 0, row.createdAt.getTime()));
  // An undone change keeps what the undo replaced, so it can be redone.
  const undone = await db.fileCheckpoint.findMany({ where: { undoneAt: { not: null }, afterHash: { not: null } }, select: { afterHash: true, undoneAt: true } });
  for (const row of undone) neededAt.set(row.afterHash!, Math.max(neededAt.get(row.afterHash!) ?? 0, row.undoneAt!.getTime()));
  const baseline = keptSnapshotHashes();
  const kept: { hash: string; bytes: number; needed: number; undo: boolean }[] = [];
  for (const blob of await listBlobs()) {
    const needed = neededAt.get(blob.hash);
    if (needed === undefined && !baseline.has(blob.hash) && blob.modified < now - GRACE_MS) await removeBlob(blob.hash);
    else kept.push({ ...blob, needed: needed ?? now, undo: needed !== undefined });
  }
  const limit = await storeLimit();
  let total = kept.reduce((sum, blob) => sum + blob.bytes, 0);
  const dropped = new Set<string>();
  if (total > limit) {
    // Copies kept only in case of a later change go first; then what undo needs, oldest first.
    for (const blob of kept.sort((a, b) => Number(a.undo) - Number(b.undo) || a.needed - b.needed)) {
      if (total <= limit) break;
      await removeBlob(blob.hash);
      dropped.add(blob.hash);
      total -= blob.bytes;
    }
  }
  // Well under the limit again: files refused while it was full may be copied.
  if (total < limit * 0.9) storeHasRoom();
  if (!dropped.size) return;
  dropKeptSnapshotHashes(dropped);
  const hashes = [...dropped];
  for (let index = 0; index < hashes.length; index += 500) {
    await db.fileCheckpoint.updateMany({ where: { beforeHash: { in: hashes.slice(index, index + 500) }, beforeGitOid: null, restorable: true }, data: { restorable: false, reason: "expired" } });
  }
}

/** A folder's access ended: what was kept for undoing changes in it goes. */
export async function forgetCheckpointsForGrant(grantId: string) {
  await db.fileCheckpoint.deleteMany({ where: { grantId } });
  pruneCheckpointsSoon();
}
