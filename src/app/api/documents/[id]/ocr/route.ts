import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { retryDocumentOcr } from "@/lib/documents/ocr/runner";
import { documentIdSchema } from "@/lib/documents/types";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readEmptyBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

type Context = { params: Promise<{ id: string }> };
/** Reads a scanned document's pages again after the reading failed, from the pages not read yet. */
async function POSTHandler(req: NextRequest, context: Context) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documents");
    const id = documentIdSchema.parse((await context.params).id);
    await readEmptyBody(req);
    await retryDocumentOcr(id);
    return Response.json({ data: { id } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.ocrRetryFailed")); }
}
export const POST = protectDataOperation(POSTHandler);
