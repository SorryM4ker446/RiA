import { withModelCallSource } from "@/lib/models/call-context";
import type { Prisma } from "@prisma/client";
import { db } from "@/db";
import { pruneWorkspaceEvents } from "@/lib/activity/events";
import { ACTIVITY_LIMITS, EVENT_KINDS, eventLabel, factsSchema, type ReviewFacts } from "@/lib/activity/types";
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
function escapeLabel(value: string) { return value.replace(/[\\`*_[\]<>#|]/g, "\\$&").replace(/[\r\n]/g, " "); }
export function formatReview(window: { period: string; timeZone: string; startAt: Date; endAt: Date }, facts: ReviewFacts) {
  return [
    `## ${window.period === "weekly" ? "每周" : "每日"}事实回顾`,
    `时区：${window.timeZone}；统计区间：${window.startAt.toISOString()} ≤ 时间 < ${window.endAt.toISOString()}。`,
    facts.complete ? "本区间的事件记录完整。" : `仅从 ${facts.coverageFrom} 开始保留完整事件记录，之前的活动无法还原；以下是已记录的变化，不代表完整期间总量。`,
    ...EVENT_KINDS.map(kind => `- ${eventLabel(kind)}：${facts.counts[kind]} 次`),
    "完成和重新打开分别计数，同一任务可以发生多次状态变化；不以当前状态推断历史完成时间。",
    facts.sources.length ? "### 记录来源" : "本区间没有已记录的变化。",
    ...facts.sources.map(source => `- ${eventLabel(source.kind)} · [${escapeLabel(source.label)}](/activity/events/${encodeURIComponent(source.id)}) · ${source.occurredAt}`),
    facts.omitted ? `仅列出前 ${ACTIVITY_LIMITS.sources} 个来源，另外 ${facts.omitted} 个事件已计入统计。` : "",
  ].filter(Boolean).join("\n\n");
}
async function pruneReviews(tx: Prisma.TransactionClient, now: Date) {
  await tx.workspaceReview.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ACTIVITY_LIMITS.reviewDays * 86_400_000) }, modelStatus: { not: "pending" } } });
  const active = await tx.workspaceReview.count({ where: { modelStatus: "pending" } });
  const boundary = await tx.workspaceReview.findMany({ where: { modelStatus: { not: "pending" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: Math.max(0, ACTIVITY_LIMITS.reviews - active), take: 1, select: { id: true, createdAt: true } });
  if (boundary[0]) await tx.workspaceReview.deleteMany({ where: { modelStatus: { not: "pending" }, OR: [
    { createdAt: { lt: boundary[0].createdAt } }, { createdAt: boundary[0].createdAt, id: { lte: boundary[0].id } },
  ] } });
}
export async function generateWorkspaceReview(period: "daily" | "weekly", timeZone: string, useModel: boolean, now = new Date()) {
  const window = reviewWindow(period, timeZone, now);
  const prepared = await db.$transaction(async tx => {
    const key = { period, timeZone: window.timeZone, startAt: window.startAt };
    const existing = await tx.workspaceReview.findUnique({ where: { period_timeZone_startAt: key } });
    if (existing) {
      // A deleted conversation can be recreated from its frozen facts without
      // making another model request or manufacturing new events.
      if (!existing.chatId) {
        const facts = factsSchema.parse(existing.facts);
        const chat = await createReviewConversation(tx, window, formatReview(window, facts) + (existing.modelText ? `\n\n### 模型解读（仅供参考）\n\n${existing.modelText}` : ""));
        await tx.workspaceReview.update({ where: { id: existing.id }, data: { chatId: chat.id } });
        return { review: { ...existing, chatId: chat.id }, fresh: false };
      }
      return { review: existing, fresh: false };
    }
    const facts = await readReviewFacts(tx, window, now);
    const chat = await createReviewConversation(tx, window, formatReview(window, facts));
    const review = await tx.workspaceReview.create({ data: { ...key, endAt: window.endAt, facts, chatId: chat.id,
      modelStatus: useModel && facts.sources.length ? "pending" : useModel ? "empty" : "disabled",
    } });
    await pruneReviews(tx, now);
    return { review, fresh: true };
  });
  let review = prepared.review;
  if (prepared.fresh && review.modelStatus === "pending") {
    let modelText: string | null = null, modelError: string | null = null;
    try {
      const { preferredModel } = await import("@/lib/models/preferences");
      const { getChatModel } = await import("@/lib/ai/client");
      const { generateText } = await import("ai");
      const ref = await preferredModel("chat");
      const model = withModelCallSource("scheduled", () => getChatModel(ref));
      const facts = factsSchema.parse(review.facts);
      const result = await callUpstream(() => withModelCallSource("scheduled", () => generateText({ model, maxRetries: 0, maxOutputTokens: 512, abortSignal: AbortSignal.timeout(60_000),
        system: "Write two short Simplified Chinese sentences interpreting only the supplied recorded event counts. Do not invent activity, task completion dates, causes, source links or unrecorded facts. Partial coverage must be stated. This text is commentary; the deterministic report remains authoritative.",
        prompt: JSON.stringify({ timeZone: window.timeZone, startAt: window.startAt, endAt: window.endAt, counts: facts.counts, complete: facts.complete, coverageFrom: facts.coverageFrom }),
      })));
      modelText = result.text.trim() || null;
      if (!modelText) modelError = "UPSTREAM_FAILED";
    } catch (error) { modelError = scheduledErrorCode(error); }
    review = await db.$transaction(async tx => {
      const updated = await tx.workspaceReview.update({ where: { id: review.id }, data: { modelStatus: modelError ? "failed" : "succeeded", modelError, modelText } });
      if (updated.chatId && modelText) await tx.message.updateMany({ where: { chatId: updated.chatId, role: "assistant" }, data: {
        content: formatReview(window, factsSchema.parse(updated.facts)) + `\n\n### 模型解读（仅供参考）\n\n${modelText}`,
      } });
      return updated;
    });
  }
  return { review, reused: !prepared.fresh };
}
async function createReviewConversation(tx: Prisma.TransactionClient, window: ReturnType<typeof reviewWindow>, content: string) {
  const chat = await tx.chat.create({ data: { title: `${window.period === "weekly" ? "每周" : "每日"}事实回顾 · ${window.startDate}` } });
  await tx.message.createMany({ data: [
    { chatId: chat.id, role: "user", content: `查看 ${window.timeZone} 时区的${window.period === "weekly" ? "上一个完整周" : "上一个完整日"}事实回顾。`, status: "success" },
    { chatId: chat.id, role: "assistant", content, status: "success" },
  ] });
  return chat;
}
