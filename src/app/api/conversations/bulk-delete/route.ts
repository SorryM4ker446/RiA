import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { bulkDeleteSchema, deleteConversations } from "@/lib/conversations/mutations";

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("conversationBulkDelete", user.id);
    const input = bulkDeleteSchema.parse(await readJsonBody(req, 16 * 1024));
    return Response.json({ data: { deletedCount: await deleteConversations(user.id, input.ids) } });
  } catch (error) { return createApiErrorResponse(error, "Failed to delete conversations"); }
}
