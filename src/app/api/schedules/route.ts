import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createScheduledJob, listScheduledJobs, scheduleInputSchema } from "@/lib/scheduler/jobs";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await listScheduledJobs() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.schedules.listFailed"));
  }
});

/**
 * A schedule is created already disabled unless the user said otherwise.
 *
 * Creating one switched on is the normal case, but the default is off so that
 * a form that forgets the checkbox produces a schedule that does nothing
 * rather than one that starts making backups on its own.
 */
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("backups");
    const parsed = scheduleInputSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid schedule" });
    try {
      const data = await createScheduledJob(parsed.data);
      return Response.json({ data }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && error.message === "too-many-jobs") {
        throw new ApiError({ code: "VALIDATION_ERROR", message: "too-many-schedules" });
      }
      throw error;
    }
  } catch (error) {
    return createApiErrorResponse(error, t("api.schedules.createFailed"));
  }
});
