import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readEmptyBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { claimTaskReminders } from "@/lib/tasks/service";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    if (process.env.APP_RUNTIME !== "desktop") {
      throw new ApiError({ code: "FORBIDDEN", message: "Task notifications require the desktop application." });
    }
    enforceRateLimit("reminders");
    await readEmptyBody(req);
    return Response.json({ data: await claimTaskReminders() });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to check task reminders");
  }
}

export const POST = protectDataOperation(POSTHandler);
