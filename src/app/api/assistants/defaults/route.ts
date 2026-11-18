import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { listAssistants, restoreDefaultAssistants } from "@/lib/assistants/store";

import { t } from "@/lib/locale";
/** Puts back the default templates that were deleted; the ones still present keep their edits. */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("assistantTemplates");
    const restored = await restoreDefaultAssistants();
    return Response.json({ data: await listAssistants(), restored });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.assistantDefaults")); }
}
export const POST = protectDataOperation(POSTHandler);
