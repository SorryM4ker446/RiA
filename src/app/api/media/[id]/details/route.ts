import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { getMediaDetail } from "@/lib/media/library";
async function GETHandler(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try { const user = await requireRequestUser(req); return Response.json({ data: await getMediaDetail(user.id, (await context.params).id) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "无法读取媒体详情。"); }
}

export const GET = protectDataOperation(GETHandler);
