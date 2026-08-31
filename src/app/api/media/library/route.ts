import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { listMediaLibrary } from "@/lib/media/library";
export async function GET(req: NextRequest) {
  try { const user = await requireRequestUser(req); return Response.json(await listMediaLibrary(user.id, req.nextUrl.searchParams), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return createApiErrorResponse(error, "无法读取媒体资源库。"); }
}
