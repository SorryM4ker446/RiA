import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { searchDocuments } from "@/lib/documents/retrieval";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";

const schema = z.strictObject({ query: z.string().trim().min(1).max(2000) });
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tools");
    const { query } = schema.parse(await readJsonBody(req));
    return Response.json({ data: await searchDocuments(query, 6) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "检索文档失败。"); }
}

export const POST = protectDataOperation(POSTHandler);
