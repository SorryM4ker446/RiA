import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readEmptyBody } from "@/lib/server/request-body";
import { claimNoticesToAnnounce } from "@/lib/scheduler/notices";

/** A claim, not a read: each notice is handed over once, for the desktop to show as a system notification. */
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    if (process.env.APP_RUNTIME !== "desktop") {
      throw new ApiError({ code: "FORBIDDEN", message: "Task notifications require the desktop application." });
    }
    enforceRateLimit("reminders");
    await readEmptyBody(req);
    const notices = await claimNoticesToAnnounce();
    return Response.json({ data: notices.map(({ id, title, detail, href }) => ({ id, title, detail, href })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to check task notifications");
  }
});
