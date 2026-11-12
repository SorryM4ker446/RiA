import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { readChatRequest } from "@/lib/chat/request";
import { answerChatRequest } from "@/lib/chat/turn";
import { holdTurn } from "@/lib/chat/live-turns";
import { prepareChatPersistence } from "@/lib/chat/persistence";
import { markTurnAnswered } from "@/lib/conversations/mutations";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";

/**
 * Starts a turn. The service holds it: the page reading the answer may leave,
 * and come back to it at /api/chat/[id]/stream, without ending it. Only
 * stopping it there does. With every place for model work taken, the turn
 * waits for one, and its stream says so until it starts.
 */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("chat");
    const input = await readChatRequest(req);
    // Given up before it was read (stopped at once): nobody wants this turn. Once
    // started, the request ending no longer ends it.
    if (req.signal.aborted) return new Response(null, { status: 204 });
    return await holdTurn(input.requestedChatId ?? crypto.randomUUID(), signal => answerChatRequest(input, signal), {
      source: "chat",
      settle: markTurnAnswered,
      // Waiting for a place: the message is kept now, so it is there to see while it waits.
      // One that invokes a tool is checked before it is kept, so it is kept when the turn starts.
      beforeQueue: async () => { if (!input.latestUserMessage?.invocation) await prepareChatPersistence(input, { deferApproval: true }); },
    });
  } catch (error) {
    console.error("/api/chat error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to generate chat response");
  }
}

export const POST = protectDataOperation(POSTHandler);
