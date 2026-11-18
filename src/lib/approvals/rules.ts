import { z } from "zod";

/*
 * What the model may do without asking, by the kind of action a tool takes.
 *
 * The rule belongs to the conversation (a task's conversation uses the task's),
 * so two conversations can work under different rules. Every tool that changes
 * something declares one kind of action, and this one table decides it:
 *
 * | action   | ask | acceptEdits | auto   | full  |
 * | edit     | ask | allow       | allow  | allow |  files in the workspace folder
 * | command  | ask | ask         | review | allow |  terminal commands
 * | external | ask | ask         | review | allow |  extension tools (MCP, HTTP)
 * | appData  | ask | ask         | ask    | allow |  creating a task, saving a knowledge entry
 *
 * A review is a separate model call that lets the action run only when it
 * plainly serves what the user asked, and otherwise asks (see auto-review.ts);
 * commands that only read skip it. Tools that only read declare nothing and
 * never ask. A question the model puts to the user is not an approval and
 * always waits for the answer.
 */
export const APPROVAL_RULES = ["ask", "acceptEdits", "auto", "full"] as const;
export type ApprovalRule = (typeof APPROVAL_RULES)[number];
export const approvalRuleSchema = z.enum(APPROVAL_RULES);
export const DEFAULT_APPROVAL_RULE: ApprovalRule = "ask";

/** A stored rule; anything unreadable asks. */
export const readApprovalRule = (value: unknown): ApprovalRule => approvalRuleSchema.catch(DEFAULT_APPROVAL_RULE).parse(value);

export const APPROVAL_ACTIONS = ["edit", "command", "external", "appData"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type ApprovalDecision = "allow" | "review" | "ask";

/** The table above: what a rule does with an action. */
export function approvalFor(rule: ApprovalRule, action: ApprovalAction): ApprovalDecision {
  if (rule === "full") return "allow";
  if (action === "edit") return rule === "ask" ? "ask" : "allow";
  if (action === "appData") return "ask";
  return rule === "auto" ? "review" : "ask";
}

/** Whether an action goes ahead without the user, and without a review. */
export function runsWithoutAsking(rule: ApprovalRule, action: ApprovalAction): boolean {
  return approvalFor(rule, action) === "allow";
}
