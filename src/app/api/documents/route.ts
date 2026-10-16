import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { parseDocument } from "@/lib/documents/parser";
import { documentSummarySelect, indexDocument } from "@/lib/documents/store";
import { DOCUMENT_LIMITS } from "@/lib/documents/types";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readDocumentUpload } from "@/lib/documents/upload";
import { hashDocumentContent, DOCUMENT_INDEX_VERSION } from "@/lib/documents/chunks";
import { t } from "@/lib/locale";
import { semanticCoverage } from "@/lib/documents/semantic";

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected query parameter" });
    const data = await db.knowledgeDocument.findMany({ where: {}, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: DOCUMENT_LIMITS.documentsPerUser, select: documentSummarySelect });
    const coverage = await semanticCoverage(data.map(document => document.id));
    return Response.json({ data: data.map(document => ({ ...document, semantic: {
      modelRef: coverage.modelRef, indexed: coverage.counts.get(document.id) ?? 0, total: document._count.chunks, lexicalCurrent: document.indexVersion === DOCUMENT_INDEX_VERSION,
      ...(coverage.details.get(document.id) ?? { stale: 0, differentModel: 0, invalid: 0 }),
    } })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.listFailed")); }
}

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("documents");
    const { file, filename, format, collection, previewHash, base } = await readDocumentUpload(req);
    const pages = await parseDocument(new Uint8Array(await file.arrayBuffer()), format, req.signal);
    if (req.signal.aborted) throw new ApiError({ code: "VALIDATION_ERROR", message: t("api.documents.importCancelled") });
    if (previewHash && previewHash !== hashDocumentContent(JSON.stringify(pages))) throw new ApiError({ code: "CONFLICT", message: "文件与预览内容不同，请重新预览。" });
    const data = await indexDocument({ filename, collection, format, byteSize: file.size, pages }, undefined, base);
    return Response.json({ data }, { status: data.change === "created" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.importFailed")); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
