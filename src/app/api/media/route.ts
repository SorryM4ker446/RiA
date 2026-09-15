import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { getMediaStats } from "@/lib/media/storage";
import { createApiErrorResponse } from "@/lib/server/api-error";

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await getMediaStats() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "Failed to read media storage usage"); }
}

export const GET = protectDataOperation(GETHandler);
