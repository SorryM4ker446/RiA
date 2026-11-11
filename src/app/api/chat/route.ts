import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { readChatRequest } from "@/lib/chat/request";
import { answerChatRequest } from "@/lib/chat/turn";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("chat");
    return await answerChatRequest(await readChatRequest(req), req.signal);
  } catch (error) {
    console.error("/api/chat error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to generate chat response");
  }
}

export const POST = protectDataOperation(POSTHandler);
