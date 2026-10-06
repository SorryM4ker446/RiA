import type { Prisma } from "@prisma/client";
import { db } from "@/db";
import { ACTIVITY_LIMITS, type EventKind } from "@/lib/activity/types";
export async function pruneWorkspaceEvents(tx: Prisma.TransactionClient, now = new Date()) {
  const state = await tx.workspaceActivityState.upsert({ where: { id: "local" }, create: { id: "local", recordingStartedAt: now, completeSince: now }, update: {} });
  const cutoff = new Date(now.getTime() - ACTIVITY_LIMITS.days * 86_400_000);
  await tx.workspaceEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  const boundary = await tx.workspaceEvent.findMany({ orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: ACTIVITY_LIMITS.rows, take: 1, select: { occurredAt: true, id: true } });
  if (boundary[0]) await tx.workspaceEvent.deleteMany({ where: { OR: [
    { occurredAt: { lt: boundary[0].occurredAt } }, { occurredAt: boundary[0].occurredAt, id: { lte: boundary[0].id } },
  ] } });
  const completeSince = new Date(Math.max(state.completeSince.getTime(), cutoff.getTime(), boundary[0] ? boundary[0].occurredAt.getTime() + 1 : 0));
  if (completeSince.getTime() !== state.completeSince.getTime()) await tx.workspaceActivityState.update({ where: { id: "local" }, data: { completeSince } });
  return { ...state, completeSince };
}
export async function recordWorkspaceEvent(tx: Prisma.TransactionClient, event: { kind: EventKind; entityId: string; label: string }, now = new Date()) {
  const created = await tx.workspaceEvent.create({ data: { ...event, label: event.label.slice(0, 2000), occurredAt: now } });
  await pruneWorkspaceEvents(tx, now);
  return created;
}
export async function getEventSource(id: string) {
  const event = await db.workspaceEvent.findUnique({ where: { id } });
  if (!event) return null;
  const entity = event.kind.startsWith("task.")
    ? await db.task.findUnique({ where: { id: event.entityId }, select: { title: true, details: true, status: true } })
    : event.kind.startsWith("document.")
      ? await db.knowledgeDocument.findUnique({ where: { id: event.entityId }, select: { filename: true, collection: true } })
      : await db.memory.findUnique({ where: { id: event.entityId }, select: { key: true, value: true, confirmed: true } });
  return { event, entity, documentHref: entity && event.kind.startsWith("document.") ? `/knowledge/documents/${encodeURIComponent(event.entityId)}` : null };
}
