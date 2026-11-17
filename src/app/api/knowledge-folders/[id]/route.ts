import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { removeKnowledgeFolder } from "@/lib/documents/folders/sync";
import { identifierSchema } from "@/lib/server/request-schemas";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readEmptyBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

type Params = { params: Promise<{ id: string }> };

/** Stops syncing a folder; `?documents=delete` removes its documents too, `?documents=keep` leaves them as ordinary documents. */
async function DELETEHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("knowledgeFolders");
    const id = identifierSchema.safeParse((await context.params).id);
    const documents = req.nextUrl.searchParams.get("documents");
    if (!id.success) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.request.invalidId") });
    if (req.nextUrl.searchParams.size !== 1 || (documents !== "delete" && documents !== "keep")) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.knowledgeFolders.invalidRequest") });
    await readEmptyBody(req);
    await removeKnowledgeFolder(id.data, { deleteDocuments: documents === "delete" });
    return Response.json({ data: { id: id.data } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.knowledgeFolders.removeFailed")); }
}

export const DELETE = protectDataOperation(DELETEHandler);
