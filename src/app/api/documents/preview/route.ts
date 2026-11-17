import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readDocumentUpload } from "@/lib/documents/upload";
import { readImportedPages } from "@/lib/documents/import-pages";
import { buildDocumentChunks, hashDocumentContent, DOCUMENT_INDEX_VERSION } from "@/lib/documents/chunks";

import { t, tf } from "@/lib/locale";
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentPreview");
    const input = await readDocumentUpload(req, true);
    const base = await db.knowledgeDocument.findUnique({ where: { filename: input.filename }, select: { id: true, contentHash: true, collection: true } });
    const { pages, pending } = await readImportedPages(new Uint8Array(await input.file.arrayBuffer()), input.format, req.signal);
    req.signal.throwIfAborted();
    const chunks = buildDocumentChunks(pages, { allowEmpty: pending.length > 0 }).map(({ chunkKey: _key, ...chunk }) => chunk);
    return Response.json({ data: { filename: input.filename, format: input.format, collection: input.collection, byteSize: input.file.size,
      previewHash: hashDocumentContent(JSON.stringify(pages)), base, indexVersion: DOCUMENT_INDEX_VERSION,
      characterCount: pages.reduce((sum, page) => sum + page.text.length, 0), chunks,
      ocrPages: pending.length,
      notes: [t("server.preview.local"), input.format === "pdf" ? t("server.preview.pdf") : t("server.preview.table"), ...(pending.length ? [tf("server.preview.ocr", { count: pending.length })] : [])],
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.preview")); }
}
export const POST = protectDataOperation(POSTHandler);
