import { z } from "zod";
import type { UIMessage } from "ai";

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
