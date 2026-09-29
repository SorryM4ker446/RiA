import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { deleteNotice, markNoticeRead } from "@/lib/scheduler/notices";
import { identifierSchema } from "@/lib/server/request-schemas";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { t } from "@/lib/locale";

type Params = { params: Promise<{ id: string }> };

export const PATCH = protectDataOperation(async (req: NextRequest, context: Params) => {
  try {
    await requireLocalWorkspace(req);
    // Writes are rate limited here as they are on the schedule and backup
    // routes, so one client cannot rewrite notice state in a tight loop.
    enforceRateLimit("reminders");
    const { id } = await context.params;
    if (!identifierSchema.safeParse(id).success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    return Response.json({ data: await markNoticeRead(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.notices.updateFailed"));
  }
});

export const DELETE = protectDataOperation(async (req: NextRequest, context: Params) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("reminders");
    const { id } = await context.params;
    if (!identifierSchema.safeParse(id).success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    return Response.json({ data: await deleteNotice(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.notices.updateFailed"));
  }
});
