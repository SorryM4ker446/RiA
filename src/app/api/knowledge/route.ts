import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { saveMemory } from "@/lib/memory/store";
import { pageResult, readPageOptions } from "@/lib/server/pagination";

const createKnowledgeSchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(4000),
  score: z.number().min(0).max(1).optional().default(0.85),
});

// Everything the knowledge page renders, and nothing else. A stored row also
// carries the embedding vector — on the order of a thousand floats per entry —
// which no client reads and which would make every list response tens of
// megabytes on a real library.
const knowledgeEntrySelect = {
  id: true,
  key: true,
  value: true,
  score: true,
  source: true,
  confirmed: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function knowledgeEntryView(row: {
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

const knowledgeListQuerySchema = z.strictObject({
  view: z.enum(["all", "confirmed", "candidates"]).optional().default("all"),
  q: z.string().trim().max(120).regex(/^[^\u0000-\u001f\u007f]*$/).optional().default(""),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    const params = req.nextUrl.searchParams;
    for (const key of new Set(params.keys())) {
      if (params.getAll(key).length !== 1) {
        throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate knowledge query parameter" });
      }
    }
    const parsed = knowledgeListQuerySchema.safeParse(Object.fromEntries(params));

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid knowledge query",
        details: parsed.error.flatten(),
      });
    }

    const { view, q } = parsed.data;
    const scope = JSON.stringify(["knowledge", view, q]);
    const pagination = new URLSearchParams();
    if (parsed.data.limit !== undefined) pagination.set("limit", parsed.data.limit);
    if (parsed.data.cursor !== undefined) pagination.set("cursor", parsed.data.cursor);
    const options = readPageOptions(pagination, scope, 50);
    const filter = view === "all" ? Prisma.empty : Prisma.sql`AND confirmed=${view === "confirmed"}`;
    const boundary = options.cursor ? Prisma.sql`AND (updatedAt < ${options.cursor.date}
      OR (updatedAt=${options.cursor.date} AND id < ${options.cursor.id}))` : Prisma.empty;
    // instr treats '%' and '_' as literal text. Search is local and does not
    // embed queries or change which memories are eligible for model context.
    const search = q ? Prisma.sql`AND (instr(lower(key),lower(${q})) > 0
      OR instr(lower(value),lower(${q})) > 0)` : Prisma.empty;
    const result = await db.$transaction(async tx => {
      const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM memories WHERE 1=1 ${filter} ${boundary} ${search}
        ORDER BY updatedAt DESC,id DESC LIMIT ${options.limit + 1}`);
      const rows = await tx.memory.findMany({
        where: { id: { in: ids.map(row => row.id) } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: knowledgeEntrySelect,
      });
      return pageResult(rows, options, scope, row => row.updatedAt);
    });

    return Response.json(result);
  } catch (error) {
    console.error("/api/knowledge GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch knowledge entries");
  }
}

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    const parsed = createKnowledgeSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid knowledge entry",
        details: parsed.error.flatten(),
      });
    }

    const memory = await saveMemory({
      key: parsed.data.key,
      value: parsed.data.value,
      score: parsed.data.score,
    });

    return Response.json({ data: knowledgeEntryView(memory) }, { status: 201 });
  } catch (error) {
    console.error("/api/knowledge POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to save knowledge entry");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
