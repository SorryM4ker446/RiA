import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readDocumentUpload } from "@/lib/documents/upload";
import { processUpload } from "@/lib/document-processor/service";

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentPreview");
    const input = await readDocumentUpload(req, "processor");
    return Response.json({ data: await processUpload(input, req.signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "文档解析失败或已取消。"); }
});
