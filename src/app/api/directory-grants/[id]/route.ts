import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { revokeGrant } from "@/lib/local-files/grants";
import { identifierSchema } from "@/lib/server/request-schemas";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { t } from "@/lib/locale";
import { z } from "zod";
import { readJsonBody } from "@/lib/server/request-body";
import { setTerminalPermission } from "@/lib/terminal/permissions";
import { terminalApprovalModeSchema } from "@/lib/terminal/schema";

type Params = {
  params: Promise<{ id: string }>;
};

/**
 * Withdrawing a grant.
 *
 * Reports success whether or not the row was there. The caller's question is
 * whether the permission is gone, and it is — a repeated revoke, or one for a
 * grant that never existed, leaves exactly the same state.
 */
async function DELETEHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("directoryGrants");
    const { id } = await context.params;
    const parsed = identifierSchema.safeParse(id);
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    const data = await revokeGrant(parsed.data);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.directoryGrants.revokeFailed"));
  }
}

export const DELETE = protectDataOperation(DELETEHandler);

async function PATCHHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("directoryGrants");
    const parsedId = identifierSchema.safeParse((await context.params).id);
    if (!parsedId.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    const id = parsedId.data;
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    const parsed = z.strictObject({ terminalEnabled: z.boolean(), terminalApprovalMode: terminalApprovalModeSchema.default("approval"), revision: z.iso.datetime() }).safeParse(await readJsonBody(req, 1024));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid terminal permission" });
    await setTerminalPermission(id, parsed.data.terminalEnabled, parsed.data.revision, parsed.data.terminalApprovalMode);
    return Response.json({ data: { updated: true } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法更新终端权限。"); }
}

export const PATCH = protectDataOperation(PATCHHandler);
