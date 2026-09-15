import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { readEmptyBody } from "@/lib/server/request-body";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { cleanupMedia } from "@/lib/media/storage";
import { createApiErrorResponse } from "@/lib/server/api-error";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    await readEmptyBody(req);
    return Response.json({ data: await cleanupMedia() });
  } catch (error) { return createApiErrorResponse(error, "Failed to clean unused media"); }
}

export const POST = protectDataOperation(POSTHandler);
