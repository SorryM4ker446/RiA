import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readDocumentUpload } from "@/lib/documents/upload";
import { parseDocument } from "@/lib/documents/parser";
import { buildDocumentChunks, hashDocumentContent, DOCUMENT_INDEX_VERSION } from "@/lib/documents/chunks";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentPreview");
    const input = await readDocumentUpload(req, true);
    const base = await db.knowledgeDocument.findUnique({ where: { filename: input.filename }, select: { id: true, contentHash: true, collection: true } });
    const pages = await parseDocument(new Uint8Array(await input.file.arrayBuffer()), input.format, req.signal);
    req.signal.throwIfAborted();
    const chunks = buildDocumentChunks(pages).map(({ chunkKey: _key, ...chunk }) => chunk);
    return Response.json({ data: { filename: input.filename, format: input.format, collection: input.collection, byteSize: input.file.size,
      previewHash: hashDocumentContent(JSON.stringify(pages)), base, indexVersion: DOCUMENT_INDEX_VERSION,
      characterCount: pages.reduce((sum, page) => sum + page.text.length, 0), chunks,
      notes: ["预览只在本机提取文本，尚未保存或调用模型。", input.format === "pdf" ? "PDF 保留页码和提取顺序；复杂版面及表格需人工核对，扫描页需先 OCR。" : "表格以文本表示行列，长表分块重复表头；请核对合并单元格和缺失内容。"],
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "文档预览失败或已取消。"); }
}
export const POST = protectDataOperation(POSTHandler);
