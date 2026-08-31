import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { listMediaLibrary } from "@/lib/media/library";
async function GETHandler(req: NextRequest) {
  try { const user = await requireRequestUser(req); return Response.json(await listMediaLibrary(user.id, req.nextUrl.searchParams), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "无法读取媒体资源库。"); }
}

export const GET = protectDataOperation(GETHandler);
