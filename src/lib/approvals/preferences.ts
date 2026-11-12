import { db } from "@/db";
import { readApprovalRule, type ApprovalRule } from "@/lib/approvals/rules";

/** The rule a new conversation starts with. */
export async function defaultApprovalRule(): Promise<ApprovalRule> {
  const row = await db.approvalPreference.findUnique({ where: { id: "local" }, select: { defaultRule: true } });
  return readApprovalRule(row?.defaultRule);
}

/** Changes the rule new conversations start with; conversations that exist keep theirs. */
export async function saveDefaultApprovalRule(rule: ApprovalRule): Promise<ApprovalRule> {
  await db.approvalPreference.upsert({ where: { id: "local" }, create: { id: "local", defaultRule: rule }, update: { defaultRule: rule } });
  return rule;
}
