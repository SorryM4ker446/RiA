import type { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
export async function topicResponse(req: NextRequest, action: () => Promise<unknown>, allowQuery = false) {
  try {
    await requireLocalWorkspace(req);
    const params = req.nextUrl.searchParams;
    if (params.size && !allowQuery || [...params.keys()].some(key => params.getAll(key).length !== 1)) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected or duplicated query parameter" });
    return Response.json({ data: await action() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "专题操作失败。"); }
}
