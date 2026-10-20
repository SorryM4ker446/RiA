import { z } from "zod";

export const contextReportSchema = z.object({
  checks: z.number().int().nonnegative(), compactions: z.number().int().nonnegative(),
  degraded: z.boolean(), estimatedInputTokens: z.number().int().nonnegative(),
  budget: z.object({ contextWindow: z.number().int().positive(), capacitySource: z.enum(["catalog", "configured", "unknown"]), counting: z.literal("conservative-utf8-estimate") }),
});
export type ContextReport = z.infer<typeof contextReportSchema>;
