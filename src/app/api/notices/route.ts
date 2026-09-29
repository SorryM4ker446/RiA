import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { listNotices, markAllNoticesRead, unreadNoticeCount } from "@/lib/scheduler/notices";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { t } from "@/lib/locale";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    const includeRead = req.nextUrl.searchParams.get("includeRead") === "true";
    if ([...req.nextUrl.searchParams.keys()].some((key) => key !== "includeRead")) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    }
    const [notices, unread] = await Promise.all([listNotices({ includeRead }), unreadNoticeCount()]);
    return Response.json({ data: { notices, unread } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.notices.listFailed"));
  }
});

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    // Marking everything read is the one unbounded write on the notice surface:
    // it touches every unread row rather than one. The other write routes here
    // are rate limited like the rest of the API, and this one has to be too.
    enforceRateLimit("reminders");
    return Response.json({ data: await markAllNoticesRead() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, t("api.notices.listFailed"));
  }
});
