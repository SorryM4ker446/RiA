import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { parseDocument, validateDocumentFile } from "@/lib/documents/parser";
import { documentSummarySelect, indexDocument } from "@/lib/documents/store";
import { DOCUMENT_LIMITS } from "@/lib/documents/types";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readLimitedBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    const data = await db.knowledgeDocument.findMany({ where: {}, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: DOCUMENT_LIMITS.documentsPerUser, select: documentSummarySelect });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.listFailed")); }
}

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("documents");
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be multipart/form-data" });
    const bytes = await readLimitedBody(req, DOCUMENT_LIMITS.bodyBytes);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new ApiError({ code: "VALIDATION_ERROR", message: t("api.documents.invalidUpload") }); }
    const file = form.get("file");
    if ([...form.keys()].length !== 1 || !(file instanceof File)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("api.documents.singleFileField") });
    const { filename, format } = validateDocumentFile(file);
    const pages = await parseDocument(new Uint8Array(await file.arrayBuffer()), format, req.signal);
    if (req.signal.aborted) throw new ApiError({ code: "VALIDATION_ERROR", message: t("api.documents.importCancelled") });
    const data = await indexDocument({ filename, format, byteSize: file.size, pages });
    return Response.json({ data }, { status: data.change === "created" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.importFailed")); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
