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
 * - full: both run without asking.
 *
 * Creating a task and extension tools ask under every rule: they act outside
 * the folder.
 */
export const APPROVAL_RULES = ["ask", "acceptEdits", "full"] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];
export const approvalRuleSchema = z.enum(APPROVAL_RULES);
export const DEFAULT_APPROVAL_RULE: ApprovalRule = "ask";

/** A stored rule; anything unreadable asks. */
export const readApprovalRule = (value: unknown): ApprovalRule => approvalRuleSchema.catch(DEFAULT_APPROVAL_RULE).parse(value);

/** Whether an action in the workspace goes ahead without the user approving it. */
export function runsWithoutAsking(rule: ApprovalRule, action: "edit" | "command"): boolean {
  return action === "edit" ? rule !== "ask" : rule === "full";
}
