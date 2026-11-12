import { withModelCallSource } from "@/lib/models/call-context";
import type { Prisma } from "@prisma/client";
import { db } from "@/db";
import { pruneWorkspaceEvents } from "@/lib/activity/events";
import { ACTIVITY_LIMITS, EVENT_KINDS, factsSchema, type ReviewFacts } from "@/lib/activity/types";
import { reviewWindow } from "@/lib/activity/window";
import { scheduledErrorCode } from "@/lib/scheduler/history";
import { callUpstream } from "@/lib/server/api-error";

export async function readReviewFacts(tx: Prisma.TransactionClient, window: ReturnType<typeof reviewWindow>, now: Date): Promise<ReviewFacts> {
  const state = await pruneWorkspaceEvents(tx, now);
  const where = { occurredAt: { gte: window.startAt, lt: window.endAt }, kind: { in: [...EVENT_KINDS] } };
  const counts = { "task.completed": 0, "task.reopened": 0, "document.imported": 0, "document.updated": 0, "memory.confirmed": 0 };
  const grouped = await tx.workspaceEvent.groupBy({ by: ["kind"], where, _count: true });
  for (const row of grouped) counts[row.kind as keyof typeof counts] = row._count;
  const sources = await tx.workspaceEvent.findMany({ where, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: ACTIVITY_LIMITS.sources });
  return factsSchema.parse({ counts, coverageFrom: state.completeSince.toISOString(), complete: state.completeSince <= window.startAt,
    sources: sources.map(event => ({ ...event, occurredAt: event.occurredAt.toISOString() })),
    omitted: Math.max(0, Object.values(counts).reduce((sum, count) => sum + count, 0) - sources.length),
  });
}
export async function previewWorkspaceReview(period: "daily" | "weekly", timeZone: string, now = new Date()) {
  const window = reviewWindow(period, timeZone, now);
  return { ...window, facts: await db.$transaction(tx => readReviewFacts(tx, window, now)) };
}
