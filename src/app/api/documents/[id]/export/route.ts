import { z } from "zod";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { documentIdSchema } from "@/lib/documents/types";
import { exportDocument, exportResponse, loadProcessorDocument } from "@/lib/document-processor/service";
import { exportFormatSchema } from "@/lib/document-processor/schema";

export const GET = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentExport");
    const query = req.nextUrl.searchParams;
    if ([...query.keys()].some(key => !["format", "version"].includes(key) || query.getAll(key).length !== 1)) throw new ApiError({ code: "VALIDATION_ERROR", message: "无效的文档导出参数。" });
    const format = exportFormatSchema.parse(query.get("format"));
    const version = z.string().regex(/^[a-f0-9]{64}$/).parse(query.get("version"));
    const document = await loadProcessorDocument(documentIdSchema.parse((await context.params).id), { version });
    return exportResponse(await exportDocument({ filename: document.filename, content: document.content, syntax: document.syntax, format }, req.signal));
  } catch (error) { return createApiErrorResponse(error, "文档导出失败。"); }
});
