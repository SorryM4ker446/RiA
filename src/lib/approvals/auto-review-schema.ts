import { z } from "zod";

/**
 * What the Auto rule's review decided about a call, carried on the call's input
 * so the approval card and the execution record show it. Set by the server
 * only: any value the model supplies is removed before the review.
 */
export const autoReviewSchema = z.strictObject({ decision: z.enum(["allow", "ask"]), reason: z.string().max(600) });
export type AutoReview = z.infer<typeof autoReviewSchema>;
