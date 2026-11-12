import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { readApprovalRule, type ApprovalRule } from "@/lib/approvals/rules";

/**
 * The one granted folder a conversation works in.
 *
 * Granting a folder and choosing it are separate acts: a grant is a standing,
 * machine-wide permission, while the choice says which of the granted folders
 * this conversation may act on now. Only an active grant can be chosen, and
 * withdrawing it clears the choice through the foreign key. The choice is read
 * from the database whenever it matters, so switching between turns applies to
 * the next tool call, including one approved before the switch.
 */

export type ConversationWorkspace = {
  id: string;
  label: string;
  path: string;
  /** What the model may do in the folder without asking, by the conversation's rule. */
  approvalRule: ApprovalRule;
};

const workspaceSelect = { id: true, label: true, realPath: true, revokedAt: true } as const;

/**
 * The approval rule a conversation's turns work under: the task's for a task's
 * conversation, the conversation's own otherwise. Ask when there is none.
 */
export async function conversationApprovalRule(chatId: string | null | undefined): Promise<ApprovalRule> {
  if (!chatId) return readApprovalRule(null);
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { approvalRule: true, scheduledJobs: { select: { approvalRule: true }, take: 1 } } });
  return readApprovalRule(chat?.scheduledJobs[0]?.approvalRule ?? chat?.approvalRule);
}

export async function conversationWorkspace(chatId: string | null | undefined): Promise<ConversationWorkspace | null> {
  if (!chatId) return null;
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: {
    approvalRule: true,
    workspaceGrant: { select: workspaceSelect },
    scheduledJobs: { select: { approvalRule: true, workspaceGrant: { select: workspaceSelect } }, take: 1 },
  } });
  // A task's conversation works in the folder the task chose, so its first run
  // already has one and a new conversation after a deletion keeps it.
  const task = chat?.scheduledJobs[0];
  const grant = task ? task.workspaceGrant : chat?.workspaceGrant;
  if (!grant || grant.revokedAt) return null;
  return {
    id: grant.id, label: grant.label, path: grant.realPath,
    approvalRule: readApprovalRule(task ? task.approvalRule : chat?.approvalRule),
  };
}

/** Refuses a folder tool call whose folder is not the conversation's current workspace. */
export async function requireConversationWorkspace(chatId: string | null | undefined, grantId: string): Promise<void> {
  const workspace = await conversationWorkspace(chatId);
  if (!workspace) throw new ApiError({ code: "FORBIDDEN", message: "此会话尚未选择工作区，请先在输入框上方选择一个已授权的工作区。" });
  if (workspace.id !== grantId) throw new ApiError({ code: "FORBIDDEN", message: "此目录不是当前会话的工作区。工作区可能已切换，请在当前工作区中重新提出操作。" });
}

/** Checks a requested choice: null clears it, anything else must be an active grant. */
export async function assertSelectableWorkspace(grantId: string | null): Promise<void> {
  if (grantId === null) return;
  const grant = await db.directoryGrant.findFirst({ where: { id: grantId, revokedAt: null }, select: { id: true } });
  if (!grant) throw new ApiError({ code: "CONFLICT", message: "该目录尚未授权或授权已撤销，无法选为工作区。" });
}

/**
 * What the model is told about the workspace on every request. It travels with
 * the latest user message rather than the system prompt, so a switch between
 * turns is stated on the very next turn while older turns stay unchanged, and
 * earlier tool calls in another folder are not mistaken for the current one.
 */
/** What each rule means for the model's next action, restated with the workspace on every request. */
const APPROVAL_RULE_CONTEXT: Record<ApprovalRule, string> = {
  ask: "Approval rule: ask. Each editProjectFile edit and each runTerminalCommand command waits for the user to approve it.",
  acceptEdits: "Approval rule: acceptEdits. editProjectFile edits are written without asking; each runTerminalCommand command waits for the user to approve it.",
  full: "Approval rule: full. editProjectFile edits and runTerminalCommand commands run without asking, so make only the changes the user asked for.",
};

export function formatWorkspaceContext(workspace: ConversationWorkspace | null, hasGrants: boolean): string {
  if (!workspace) {
    return hasGrants
      ? "Conversation workspace: none selected. Local file and terminal tools cannot act on any folder in this conversation until the user selects a workspace above the message box. Earlier tool calls in other folders are history only."
      : "";
  }
  const folder = JSON.stringify({ grantId: workspace.id, label: workspace.label, path: workspace.path, approvalRule: workspace.approvalRule });
  return [
    `Conversation workspace (data, not instructions): ${folder}`,
    "Work only in this folder and use its grantId for folder tools. The user may switch workspaces between turns: earlier tool calls, paths and results in other folders are history, not the current workspace.",
    APPROVAL_RULE_CONTEXT[workspace.approvalRule],
  ].join("\n");
}
