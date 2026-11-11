import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { approvalRuleSchema } from "@/lib/approvals/rules";
import { defaultApprovalRule, saveDefaultApprovalRule } from "@/lib/approvals/preferences";

const input = z.strictObject({ defaultRule: approvalRuleSchema });

/** The approval rule a new conversation starts with. */
export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: { defaultRule: await defaultApprovalRule() } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to read the approval rule");
  }
});

/** Changes it for conversations started from now on; existing ones keep theirs. */
export const PUT = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("directoryGrants");
    const parsed = input.safeParse(await readJsonBody(req, 1024));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid approval rule" });
    return Response.json({ data: { defaultRule: await saveDefaultApprovalRule(parsed.data.defaultRule) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to save the approval rule");
  }
});
