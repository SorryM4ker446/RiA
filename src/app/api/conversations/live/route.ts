import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { liveTurnIds } from "@/lib/chat/live-turns";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";

/**
 * How many conversations are answering now, task runs and queued turns
 * included. Read before something that restarts the application (moving the
 * data), so the person is told what a restart would cut short.
 */
export async function GET(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: { answering: liveTurnIds().length } });
  } catch (error) {
    console.error("/api/conversations/live GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to read the conversations answering now");
  }
}
