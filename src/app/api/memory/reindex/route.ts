import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { protectDataOperation } from "@/lib/server/data-operations";
import { reindexStaleEmbeddings, staleEmbeddingSummary } from "@/lib/memory/reindex";
import { t } from "@/lib/locale";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await staleEmbeddingSummary() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.memory.reindexReadFailed")); }
});

/**
 * Re-embedding spends one request per memory, so it runs only on an explicit
 * confirmation. The rate limit is a second brake: this is not a bulk operation
 * to be repeated until the queue drains.
 */
export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("memoryReindex");
    z.strictObject({ confirm: z.literal(true) }).parse(await readJsonBody(req, 1024));
    return Response.json({ data: await reindexStaleEmbeddings() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.memory.reindexFailed")); }
});
