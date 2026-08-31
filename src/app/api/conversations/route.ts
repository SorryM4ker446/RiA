import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { truncateTitle } from "@/lib/ai/ui-message";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { createChat } from "@/lib/chat/store";
import { listConversations } from "@/lib/conversations/query";
import { enforceRateLimit } from "@/lib/server/rate-limit";

const createConversationSchema = z.strictObject({
  id: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

async function GETHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);

    if (req.nextUrl.searchParams.get("q")) enforceRateLimit("conversationSearch", user.id);
    return Response.json(await listConversations(user.id, req.nextUrl.searchParams));
  } catch (error) {
    console.error("/api/conversations GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch conversations");
  }
}

async function POSTHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const parsed = createConversationSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const conversation = await createChat({
      userId: user.id,
      chatId: parsed.data.id,
      title: truncateTitle(parsed.data.title ?? "New Chat"),
    });

    return Response.json({ data: conversation }, { status: 201 });
  } catch (error) {
    console.error("/api/conversations POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to create conversation");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
