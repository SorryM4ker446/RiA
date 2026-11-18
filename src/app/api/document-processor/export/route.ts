import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exportDocument, exportResponse } from "@/lib/document-processor/service";

import { t } from "@/lib/locale";
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentExport");
    return exportResponse(await exportDocument(await readJsonBody(req, 1024 * 1024), req.signal));
  } catch (error) { return createApiErrorResponse(error, t("server.fallback.processorExport")); }
});
