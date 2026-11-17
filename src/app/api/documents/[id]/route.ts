import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { deleteDocument, getDocument, reindexDocument } from "@/lib/documents/store";
import { scheduleDocumentIndexing } from "@/lib/documents/auto-index";
import { clearDocumentOcr } from "@/lib/documents/ocr/runner";
import { documentIdSchema } from "@/lib/documents/types";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readEmptyBody } from "@/lib/server/request-body";
import { t, tf } from "@/lib/locale";

type Context = { params: Promise<{ id: string }> };
async function GETHandler(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req);const id = documentIdSchema.parse((await context.params).id);
    return Response.json({ data: await getDocument(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.readFailed")); }
}
async function POSTHandler(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documents");
    const id = documentIdSchema.parse((await context.params).id);
    await readEmptyBody(req);
    const data = await reindexDocument(id);
    scheduleDocumentIndexing();
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.reindexFailed")); }
}
async function DELETEHandler(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req);const id = documentIdSchema.parse((await context.params).id);
    await readEmptyBody(req);
    // A synced folder is the source of its documents: one deleted here would come back with the next scan.
    const owner = await db.knowledgeFolderFile.findFirst({ where: { documentId: id }, select: { folder: { select: { label: true } } } });
    if (owner) throw new ApiError({ code: "CONFLICT", message: tf("server.knowledgeFolders.documentOwned", { folder: owner.folder.label }) });
    await deleteDocument(id);
    await clearDocumentOcr(id);
    return Response.json({ data: { id } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.deleteFailed")); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
export const DELETE = protectDataOperation(DELETEHandler);
