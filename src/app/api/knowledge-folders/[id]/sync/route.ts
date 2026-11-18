import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { scheduleFolderSync } from "@/lib/documents/folders/sync";
import { identifierSchema } from "@/lib/server/request-schemas";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readEmptyBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

type Params = { params: Promise<{ id: string }> };

/** Scans a folder now, retrying files that failed before; the scan runs in the background. */
async function POSTHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("knowledgeFolders");
    const id = identifierSchema.safeParse((await context.params).id);
    if (!id.success) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.request.invalidId") });
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.request.unexpectedQuery") });
    await readEmptyBody(req);
    if (!(await db.knowledgeFolder.count({ where: { id: id.data } }))) throw new ApiError({ code: "NOT_FOUND", message: t("server.knowledgeFolders.notFoundId") });
    scheduleFolderSync(id.data, { force: true });
    return Response.json({ data: { id: id.data } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.knowledgeFolders.syncFailed")); }
}

export const POST = protectDataOperation(POSTHandler);
