import { z } from "zod";
import { documentIdSchema } from "@/lib/documents/types";
import { exportFormatSchema } from "@/lib/document-processor/schema";

/**
 * What the user chose in the composer for one message: at most one tool and any
 * number of skills. It belongs to the message, so regenerating the message asks
 * for the same thing and a later approval resume does not ask for it again. The
 * labels keep the message readable after a tool or skill is removed; the server
 * resolves the ids and never trusts a label.
 */
const label = z.string().trim().min(1).max(280);
export const messageInvocationSchema = z.strictObject({
  tool: z.strictObject({ id: z.string().min(1).max(100), label }).optional(),
  skills: z.array(z.strictObject({ packageId: z.string().min(1).max(100), skillId: z.string().min(1).max(100), label })).optional(),
  document: z.strictObject({ id: documentIdSchema, filename: label }).optional(),
  format: exportFormatSchema.optional(),
}).refine(value => value.tool || value.skills?.length, "A tool or a skill is required");
export type MessageInvocation = z.infer<typeof messageInvocationSchema>;

/**
 * A user-role message RiA wrote itself: the reports of background sub-agents that
 * ended while the conversation was idle, which wake the model for a turn. The
 * model is told in the text that it is an automatic notice; the conversation
 * shows it as one, not as something the user said.
 */
export const messageNoticeSchema = z.strictObject({ kind: z.literal("subagents"), titles: z.array(z.string().trim().min(1).max(80)).max(50) });
export type MessageNotice = z.infer<typeof messageNoticeSchema>;
export function readMessageNotice(metadata: unknown): MessageNotice | null {
  const parsed = messageNoticeSchema.safeParse((metadata as { notice?: unknown } | null | undefined)?.notice);
  return parsed.success ? parsed.data : null;
}

/** The invocation carried by a message's metadata, or null when it has none. */
export function readMessageInvocation(metadata: unknown): MessageInvocation | null {
  const parsed = messageInvocationSchema.safeParse((metadata as { invocation?: unknown } | null | undefined)?.invocation);
  return parsed.success ? parsed.data : null;
}
