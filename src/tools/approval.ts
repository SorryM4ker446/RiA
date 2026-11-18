import { approvalFor, type ApprovalAction } from "@/lib/approvals/rules";
import { conversationApprovalRule } from "@/lib/local-files/workspace";

/**
 * A tool's approval, declared by the kind of action it takes; the conversation's
 * rule (the task's, for a task's conversation) decides from the one table in
 * rules.ts whether it runs, is reviewed first, or waits for the user. A new tool
 * declares its kind and follows every rule without code of its own.
 */
export const approvalGate = (action: ApprovalAction) => ({
  approval: action,
  requiresApproval: async (_input: unknown, context: { chatId?: string | null }) => approvalFor(await conversationApprovalRule(context.chatId), action) !== "allow",
});
