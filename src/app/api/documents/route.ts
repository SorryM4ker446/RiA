import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { saveImportedDocument } from "@/lib/documents/import-file";
import { documentOcrProgress, resumeDocumentOcr } from "@/lib/documents/ocr/runner";
import { documentSummarySelect } from "@/lib/documents/store";
import { DOCUMENT_LIMITS } from "@/lib/documents/types";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readDocumentUpload } from "@/lib/documents/upload";
import { DOCUMENT_INDEX_VERSION } from "@/lib/documents/chunks";
import { t } from "@/lib/locale";
import { semanticCoverage } from "@/lib/documents/semantic";
import { documentIndexingStatus, resumeDocumentIndexing, scheduleDocumentIndexing } from "@/lib/documents/auto-index";
import { staleEmbeddingSummary } from "@/lib/knowledge/entry-reindex";

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    if (req.nextUrl.searchParams.size) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.request.unexpectedQuery") });
    const data = await db.knowledgeDocument.findMany({ where: {}, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: DOCUMENT_LIMITS.documentsPerUser, select: documentSummarySelect });
    const coverage = await semanticCoverage(data.map(document => document.id));
    const ocr = await documentOcrProgress(data.map(document => document.id));
    const owners = new Map((await db.knowledgeFolderFile.findMany({ where: { documentId: { in: data.map(document => document.id) } }, select: { documentId: true, folder: { select: { id: true, label: true } } } })).map(row => [row.documentId!, row.folder]));
    await resumeDocumentOcr();
    resumeDocumentIndexing(Boolean(coverage.modelRef) && (data.some(document => (coverage.counts.get(document.id) ?? 0) < document._count.chunks || document.indexVersion !== DOCUMENT_INDEX_VERSION) || (await staleEmbeddingSummary()).stale > 0));
    return Response.json({ indexing: documentIndexingStatus(), data: data.map(document => ({ ...document, semantic: {
      modelRef: coverage.modelRef, indexed: coverage.counts.get(document.id) ?? 0, total: document._count.chunks, lexicalCurrent: document.indexVersion === DOCUMENT_INDEX_VERSION,
      ...(coverage.details.get(document.id) ?? { stale: 0, differentModel: 0, invalid: 0 }),
    }, ...(ocr.has(document.id) ? { ocr: ocr.get(document.id) } : {}), ...(owners.has(document.id) ? { folder: owners.get(document.id) } : {}) })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.listFailed")); }
}

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("documents");
    const { file, filename, format, collection, previewHash, base } = await readDocumentUpload(req);
    const data = await saveImportedDocument({ filename, collection, format, bytes: new Uint8Array(await file.arrayBuffer()), signal: req.signal, previewHash, base });
    scheduleDocumentIndexing();
    return Response.json({ data }, { status: data.change === "created" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.importFailed")); }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
