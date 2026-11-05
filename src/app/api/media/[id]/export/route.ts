import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exportDocument, exportResponse, loadAttachmentDocument } from "@/lib/document-processor/service";
import { exportFormatSchema } from "@/lib/document-processor/schema";

/** The converted copy of a document attachment. A stored attachment never changes, so no version is needed. */
export const GET = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentExport");
    const query = req.nextUrl.searchParams;
    if ([...query.keys()].some(key => key !== "format" || query.getAll(key).length !== 1)) throw new ApiError({ code: "VALIDATION_ERROR", message: "无效的文档导出参数。" });
    const format = exportFormatSchema.parse(query.get("format"));
    const document = await loadAttachmentDocument((await context.params).id, req.signal);
    return exportResponse(await exportDocument({ filename: document.filename, content: document.content, syntax: document.syntax, format }, req.signal));
  } catch (error) { return createApiErrorResponse(error, "文档导出失败。"); }
});
