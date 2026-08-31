import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { getRelevantMemories, saveMemory } from "@/lib/memory/store";

const saveMemorySchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(4000),
  score: z.number().min(0).max(1).optional(),
});

const querySchema = z.strictObject({ query: z.string().trim().max(2000).default(""), limit: z.coerce.number().int().min(1).max(20).default(5) });

async function GETHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const { query, limit } = querySchema.parse({ query: req.nextUrl.searchParams.get("query") ?? undefined, limit: req.nextUrl.searchParams.get("limit") ?? undefined });

    if (!query) {
      return Response.json({ data: [], message: "query is empty" });
    }

    const memories = await getRelevantMemories({
      userId: user.id,
      query,
      limit,
    });

    return Response.json({ data: memories });
  } catch (error) {
    console.error("/api/memory GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch memories");
  }
}

async function POSTHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const parsed = saveMemorySchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const memory = await saveMemory({
      userId: user.id,
      key: parsed.data.key,
      value: parsed.data.value,
      score: parsed.data.score,
    });

    return Response.json({ data: memory }, { status: 201 });
  } catch (error) {
    console.error("/api/memory POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to save memory");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
