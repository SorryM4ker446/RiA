import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { revokeGrant } from "@/lib/local-files/grants";
import { identifierSchema } from "@/lib/server/request-schemas";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { t } from "@/lib/locale";

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
