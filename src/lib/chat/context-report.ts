import { z } from "zod";

export const contextReportSchema = z.object({
  checks: z.number().int().nonnegative(), compactions: z.number().int().nonnegative(),
  degraded: z.boolean(), estimatedInputTokens: z.number().int().nonnegative(),
  // Absent on records saved before provider usage calibrated the estimate.
  usageCalibration: z.number().min(1).optional(),
  // Set when this turn ran out of summary calls and kept labelled excerpts.
  compactionAllowanceExhausted: z.boolean().optional(),
  // Older records name the byte count they were planned with.
  budget: z.object({ contextWindow: z.number().int().positive(), capacitySource: z.enum(["catalog", "configured", "unknown"]), counting: z.enum(["conservative-utf8-estimate", "character-class-estimate"]) }),
});
export type ContextReport = z.infer<typeof contextReportSchema>;
