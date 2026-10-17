import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { documentIdSchema } from "@/lib/documents/types";
import { loadProcessorDocument } from "@/lib/document-processor/service";

export const GET = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await loadProcessorDocument(documentIdSchema.parse((await context.params).id)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取知识库文档。"); }
});
