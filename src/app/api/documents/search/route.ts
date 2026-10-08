import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { retrieveDocuments } from "@/lib/documents/retrieval";
import { retrievalPolicySchema } from "@/lib/assistants/schema";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { t } from "@/lib/locale";

const schema = z.strictObject({ query: z.string().trim().min(1).max(2000), collections: z.array(z.string().trim().min(1).max(40)).max(12).optional(), policy: retrievalPolicySchema.optional() });
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tools");
    const { query, collections, policy } = schema.parse(await readJsonBody(req));
    const result = await retrieveDocuments(query, 8, collections, req.signal, policy);
    return Response.json({ data: result.sources, diagnostics: result.diagnostics }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, t("api.documents.searchFailed")); }
}

export const POST = protectDataOperation(POSTHandler);
