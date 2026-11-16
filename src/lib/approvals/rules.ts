import { z } from "zod";

/*
 * What the model may do in a conversation's workspace folder without asking.
 *
 * A granted folder is one the model may work in, terminal included; the rule
 * is the only thing that decides whether an action waits for the user. It
 * belongs to the conversation (a task's conversation uses the task's), so two
 * conversations in one folder can work under different rules.
 *
 * - ask: the user approves each file edit and each terminal command.
 * - acceptEdits: file edits are made directly; terminal commands are approved.
 * - auto: file edits are made directly; a terminal command, or an extension
 *   tool call, is first reviewed by a separate model call, and runs without
 *   asking only if that review allows it (see auto-review.ts). Commands that
 *   only read skip the review.
 * - full: edits and commands run without asking.
 *
 * Creating a task and saving a knowledge entry ask under every rule; extension
 * tools ask under every rule but auto.
 */
export const APPROVAL_RULES = ["ask", "acceptEdits", "auto", "full"] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];
export const approvalRuleSchema = z.enum(APPROVAL_RULES);
export const DEFAULT_APPROVAL_RULE: ApprovalRule = "ask";

/** A stored rule; anything unreadable asks. */
export const readApprovalRule = (value: unknown): ApprovalRule => approvalRuleSchema.catch(DEFAULT_APPROVAL_RULE).parse(value);

/** Whether an action in the workspace goes ahead without the user approving it, or a review under auto. */
export function runsWithoutAsking(rule: ApprovalRule, action: "edit" | "command"): boolean {
  return action === "edit" ? rule !== "ask" : rule === "full";
}
