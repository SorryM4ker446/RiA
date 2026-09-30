import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { LocalFileRefused, localGrantLabelSchema } from "@/lib/local-files/limits";
import { resolveGrant } from "@/lib/local-files/safe-path";

/**
 * Directories the user has opened to the assistant.
 *
 * A grant is a permission, not content, so it is not part of workspace backup
 * or restore. It is read from the database on every use rather than cached:
 * revoking has to take effect on the next operation, and a cached copy is
 * exactly how a revoked grant would keep working for the rest of a session.
 */

export type DirectoryGrantView = {
  id: string;
  label: string;
  path: string;
  /** Where the filesystem actually put it. Shown so the user can recognise a grant. */
  realPath: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const grantViewSelect = {
  id: true,
  label: true,
  path: true,
  realPath: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true
} as const;

function toView(row: {
  id: string;
  label: string;
  path: string;
  realPath: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): DirectoryGrantView {
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    realPath: row.realPath,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null
  };
}

export async function listGrants(options: { includeRevoked?: boolean } = {}): Promise<DirectoryGrantView[]> {
  const rows = await db.directoryGrant.findMany({
    where: options.includeRevoked ? {} : { revokedAt: null },
    orderBy: [{ createdAt: "desc" }],
    select: grantViewSelect
  });
  return rows.map(toView);
}

/**
 * Record a grant the user gave.
 *
 * The path is resolved before it is stored, so what is written down is the
 * location the filesystem actually has rather than a name that could point
 * somewhere else later. Granting a directory that is already granted returns
 * the existing row instead of a second one, and revives it if it was revoked:
 * the user asked for this permission again, which is the decision that matters.
 * That holds for two requests arriving at once as well as for one arriving
 * later: the real path is unique, so the request that loses the race is the one
 * that revives the row the winner created.
 */
export async function createGrant(input: { label?: string; path: string }): Promise<DirectoryGrantView> {
  const resolved = await resolveGrant({ label: input.label ?? "", path: input.path });
  const label = localGrantLabelSchema.parse(resolved.label);

  const existing = await findByRealPath(resolved.realPath);
  if (existing) return reviveGrant(existing.id, label, resolved.path);

  try {
    const row = await db.directoryGrant.create({
      data: { label, path: resolved.path, realPath: resolved.realPath },
      select: grantViewSelect
    });
    return toView(row);
  } catch (error) {
    // Two requests for one folder can both read the table and both find nothing,
    // because the read and the insert are not one step. The unique real path is
    // what settles it: the loser takes the re-grant branch instead of leaving a
    // second row the user cannot tell apart, and cannot meaningfully revoke.
    if (!isUniqueViolation(error)) throw error;
    const winner = await findByRealPath(resolved.realPath);
    if (!winner) throw error;
    return reviveGrant(winner.id, label, resolved.path);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.name === "PrismaClientKnownRequestError" && (error as { code?: string }).code === "P2002";
}

async function findByRealPath(realPath: string): Promise<{ id: string } | null> {
  return db.directoryGrant.findFirst({
    where: { realPath },
    orderBy: [{ createdAt: "desc" }],
    select: { id: true }
  });
}

/** Put the permission back: same row, withdrawn state cleared, so its identity is the one the caller already knows. */
async function reviveGrant(id: string, label: string, resolvedPath: string): Promise<DirectoryGrantView> {
  const row = await db.directoryGrant.update({
    where: { id },
    data: { label, path: resolvedPath, revokedAt: null, lastUsedAt: null },
    select: grantViewSelect
  });
  return toView(row);
}

/**
 * Withdraw a grant.
 *
 * Revoking keeps the row rather than deleting it, so the settings page can show
 * what was removed and when. It is reported as absent once revoked whether or
 * not the row still exists, because the caller's question is whether the
 * permission is gone, not whether a record of it is.
 */
export async function revokeGrant(id: string): Promise<{ revoked: true }> {
  const existing = await db.directoryGrant.findUnique({ where: { id }, select: { id: true, revokedAt: true } });
  if (!existing) return { revoked: true };
  if (!existing.revokedAt) {
    await db.directoryGrant.update({ where: { id }, data: { revokedAt: new Date() } });
  }
  return { revoked: true };
}

/**
 * A grant the assistant is about to act on, proven still active.
 *
 * This is the only way a tool should obtain a grant. Reading the row here,
 * rather than accepting one that was passed in, is what makes a revoke take
 * effect immediately: a run that started before the revoke still fails at its
 * next step.
 */
export async function requireActiveGrant(id: string): Promise<{ id: string; label: string; path: string; realPath: string }> {
  const row = await db.directoryGrant.findUnique({ where: { id }, select: { id: true, label: true, path: true, realPath: true, revokedAt: true } });
  if (!row || row.revokedAt) {
    throw new LocalFileRefused("outside-grant", "That folder is not available.");
  }
  return { id: row.id, label: row.label, path: row.path, realPath: row.realPath };
}

/**
 * Stamp a grant as used, so the settings page can show what is actually in play.
 *
 * Written as raw SQL on purpose. `updatedAt` is the resource version an approved
 * write is bound to, and Prisma stamps it on every update — so the ordinary
 * `updateMany` this used to issue made *using* a folder look like the folder had
 * *changed*, and a write the user was looking at got refused with a message
 * saying the folder had moved. A revoke or a re-point still goes through
 * `revokeGrant` and friends, which do move the version, which is what the
 * binding is meant to catch.
 */
export async function touchGrant(id: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE directory_grants SET lastUsedAt = ${new Date()} WHERE id = ${id} AND revokedAt IS NULL
  `);
}

/**
 * Whether the assistant may be offered the local-file tools at all.
 *
 * Checked where the tool set is built rather than inside each tool, so a
 * workspace with no granted folder is simply not offered the tools — the model
 * cannot pick one, spend a step on it, or report a read that never happened.
 * Withdrawing every folder therefore takes the tools away again on the next
 * turn without anything having to be switched off.
 */
export async function listActiveGrants(): Promise<{ id: string; label: string; path: string }[]> {
  const rows = await db.directoryGrant.findMany({
    where: { revokedAt: null },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, label: true, path: true }
  });
  return rows;
}
