import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { attachTurn, stopTurn } from "@/lib/chat/live-turns";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";

type Params = { params: Promise<{ id: string }> };

/**
 * The turn running in a conversation. GET reads it from its start and follows
 * it to its end (where the chat page reconnects after leaving or reloading);
 * 204 when none is running. DELETE stops it.
 */
export async function GET(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    return attachTurn(id) ?? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("/api/chat/[id]/stream GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to read the answer");
  }
}

export async function DELETE(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    return Response.json({ data: { stopped: stopTurn(id) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("/api/chat/[id]/stream DELETE error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to stop the answer");
  }
}
