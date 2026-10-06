import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { deleteScheduledJob, schedulePatchSchema, updateScheduledJob } from "@/lib/scheduler/jobs";
import { identifierSchema } from "@/lib/server/request-schemas";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

type Params = { params: Promise<{ id: string }> };

export const PATCH = protectDataOperation(async (req: NextRequest, context: Params) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("backups");
    const { id } = await context.params;
    const identifier = identifierSchema.safeParse(id);
    if (!identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    const parsed = schedulePatchSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid schedule" });
    const data = await updateScheduledJob(identifier.data, parsed.data);
    if (!data) throw new ApiError({ code: "NOT_FOUND", message: "Schedule not found" });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.schedules.updateFailed"));
  }
});

export const DELETE = protectDataOperation(async (req: NextRequest, context: Params) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("backups");
    const { id } = await context.params;
    const identifier = identifierSchema.safeParse(id);
    if (!identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    const result = await deleteScheduledJob(identifier.data);
    // The same condition PATCH above answers with a 404. Reporting a delete of
    // a row that is not there as a success let the interface show the entry
    // going away and then find it again on the next load.
    if (!result.deleted) throw new ApiError({ code: "NOT_FOUND", message: "Schedule not found" });
    return Response.json({ data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.schedules.deleteFailed"));
  }
});
