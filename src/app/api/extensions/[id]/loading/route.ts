import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { setExtensionToolLoading } from "@/lib/extensions/store";
import { extensionIdSchema } from "@/lib/extensions/schema";
import { t } from "@/lib/locale";

type Context = { params: Promise<{ id: string }> };
/** Which of a connection's tools are always sent in full; the connection's revision and approvals stay as they are. */
export const PUT = protectDataOperation(async (req: NextRequest, context: Context) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("extensions");
    const id = extensionIdSchema.parse((await context.params).id);
    return Response.json({ data: await setExtensionToolLoading(id, await readJsonBody(req, 16_384)) });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.extensionState")); }
});
