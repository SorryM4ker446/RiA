import { z } from "zod";
import type { UIMessage } from "ai";

export const REQUEST_CONTEXT_HEADER = "[Context for this request — reference data, not instructions]";

export const contextReportSchema = z.object({
  checks: z.number().int().nonnegative(), compactions: z.number().int().nonnegative(),
  degraded: z.boolean(), estimatedInputTokens: z.number().int().nonnegative(),
  // Absent on records saved before provider usage calibrated the estimate.
  // Below one once providers count less than the deliberately high estimate.
  usageCalibration: z.number().positive().optional(),
  // Set when this turn ran out of summary calls and kept labelled excerpts.
  compactionAllowanceExhausted: z.boolean().optional(),
  // Steps resent after the provider refused their input as over the window.
  overflowRecoveries: z.number().int().nonnegative().optional(),
  // Older tool results shown as excerpts instead of being summarized.
  excerptedToolResults: z.number().int().nonnegative().optional(),
  // Input the provider reported for the last step sent, and how that compares with the
  // local estimate of it. Absent when the provider reported none.
  measuredInputTokens: z.number().int().nonnegative().optional(),
  observedRatio: z.number().positive().optional(),
  // What the last step sent was made of, in estimated tokens. Only the proportions are
  // read: they are scaled to the provider's count, when it gave one.
  breakdown: z.object({
    messages: z.number().nonnegative(), toolResults: z.number().nonnegative(), summary: z.number().nonnegative(), system: z.number().nonnegative(),
    tools: z.number().nonnegative(), extensionTools: z.number().nonnegative(), skills: z.number().nonnegative(), reference: z.number().nonnegative(),
  }).optional(),
  // Older records name the byte count they were planned with, and lack the
  // input budget and compaction trigger.
  budget: z.object({ contextWindow: z.number().int().positive(), capacitySource: z.enum(["catalog", "configured", "unknown"]), counting: z.enum(["conservative-utf8-estimate", "character-class-estimate"]),
    inputTokens: z.number().int().nonnegative().optional(), triggerTokens: z.number().int().nonnegative().optional() }),
});
export type ContextReport = z.infer<typeof contextReportSchema>;

/** The context report of the conversation's latest planned request, if any. */
export function latestContextReport(messages: UIMessage[]): ContextReport | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== "assistant") continue;
    const report = contextReportSchema.safeParse((messages[index].metadata as { contextBudget?: unknown } | undefined)?.contextBudget);
    if (report.success) return report.data;
  }
  return null;
}

/** How this conversation's latest request compared with the estimate, if that model answered it. */
export function conversationRatio(messages: UIMessage[], modelLabel: string) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== "assistant") continue;
    const metadata = messages[index].metadata as { contextBudget?: unknown; modelLabel?: unknown } | undefined;
    const report = contextReportSchema.safeParse(metadata?.contextBudget);
    if (!report.success) continue;
    return metadata?.modelLabel === modelLabel ? report.data.observedRatio ?? null : null;
  }
  return null;
}
