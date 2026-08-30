import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { getMediaStats } from "@/lib/media/storage";
import { createApiErrorResponse } from "@/lib/server/api-error";

export async function GET(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    return Response.json({ data: await getMediaStats(user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "Failed to read media storage usage"); }
}
