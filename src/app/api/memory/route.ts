import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { getRelevantMemories, saveMemory } from "@/lib/memory/store";

const saveMemorySchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(4000),
  score: z.number().min(0).max(1).optional(),
});

const querySchema = z.strictObject({ query: z.string().trim().max(2000).default(""), limit: z.coerce.number().int().min(1).max(20).default(5) });

// The write echoes the stored entry back so a caller can see what was kept.
// The embedding vector is deliberately not part of it: it is on the order of a
// thousand floats, and nothing downstream of this endpoint reads it.
function memoryView(row: {
  id: string;
  key: string;
  value: string;
  score: number | null;
  source: string;
  confirmed: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const { id, key, value, score, source, confirmed, lastUsedAt, createdAt, updatedAt } = row;
  return { id, key, value, score, source, confirmed, lastUsedAt, createdAt, updatedAt };
}

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    const { query, limit } = querySchema.parse({ query: req.nextUrl.searchParams.get("query") ?? undefined, limit: req.nextUrl.searchParams.get("limit") ?? undefined });

    if (!query) {
      return Response.json({ data: [], message: "query is empty" });
    }

    const memories = await getRelevantMemories({
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
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    const parsed = saveMemorySchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const memory = await saveMemory({
      key: parsed.data.key,
      value: parsed.data.value,
      score: parsed.data.score,
    });

    return Response.json({ data: memoryView(memory) }, { status: 201 });
  } catch (error) {
    console.error("/api/memory POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to save memory");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
