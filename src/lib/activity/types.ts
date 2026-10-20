import { t } from "@/lib/locale";
import { z } from "zod";
export const EVENT_KINDS = ["task.completed", "task.reopened", "document.imported", "document.updated", "memory.confirmed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const ACTIVITY_LIMITS = { days: 365, rows: 10_000, sources: 100, reviews: 1000, reviewDays: 90 } as const;
export const eventSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), kind: z.enum(EVENT_KINDS),
  entityId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), label: z.string().max(2000), occurredAt: z.iso.datetime(),
});
export const factsSchema = z.strictObject({
  counts: z.strictObject({ "task.completed": z.number().int().nonnegative(), "task.reopened": z.number().int().nonnegative(),
    "document.imported": z.number().int().nonnegative(), "document.updated": z.number().int().nonnegative(), "memory.confirmed": z.number().int().nonnegative() }),
  coverageFrom: z.iso.datetime(), complete: z.boolean(), sources: z.array(eventSchema).max(ACTIVITY_LIMITS.sources), omitted: z.number().int().nonnegative(),
});
export type ReviewFacts = z.infer<typeof factsSchema>;
export const eventLabel = (kind: string) => ({ "task.completed": t("ui.activity.taskCompleted"), "task.reopened": t("ui.activity.taskReopened"), "document.imported": t("ui.activity.documentImported"), "document.updated": t("ui.activity.documentUpdated"), "memory.confirmed": t("ui.activity.memoryConfirmed") })[kind] ?? t("ui.activity.change");
