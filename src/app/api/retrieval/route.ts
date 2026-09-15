import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { getRelevantMemories } from "@/lib/memory/store";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";

const retrievalSchema = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
});

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);

    const parsed = retrievalSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw parsed.error;

    const memories = await getRelevantMemories({
      query: parsed.data.query,
      limit: parsed.data.limit ?? 6,
    });

    return Response.json({ data: memories });
  } catch (error) {
    console.error("/api/retrieval POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to retrieve memories");
  }
}

export const POST = protectDataOperation(POSTHandler);
