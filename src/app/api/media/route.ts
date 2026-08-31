import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { getMediaStats } from "@/lib/media/storage";
import { createApiErrorResponse } from "@/lib/server/api-error";

async function GETHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    return Response.json({ data: await getMediaStats(user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "Failed to read media storage usage"); }
}

export const GET = protectDataOperation(GETHandler);
