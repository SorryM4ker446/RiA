import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { evaluateDocuments, evaluationRequestSchema } from "@/lib/documents/evaluation";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req); enforceRateLimit("documentEvaluation");
    const input = evaluationRequestSchema.parse(await readJsonBody(req));
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]);
    return Response.json({ data: await evaluateDocuments(input, signal) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "知识检索评测失败或已取消"); }
}
export const POST = protectDataOperation(POSTHandler);
