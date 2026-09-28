import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { saveMemory } from "@/lib/memory/store";

const createKnowledgeSchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(4000),
  score: z.number().min(0).max(1).optional().default(0.85),
});

const knowledgeListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  // What the assistant inferred is listed separately, so the default view
  // stays "what I decided to keep" and the candidates do not bury it.
  view: z.enum(["all", "confirmed", "candidates"]).optional().default("all"),
});

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    const parsed = knowledgeListQuerySchema.safeParse({
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
      view: req.nextUrl.searchParams.get("view") ?? undefined,
    });

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid knowledge query",
        details: parsed.error.flatten(),
      });
    }

    // Everything is listed, including what the assistant inferred: a memory the
    // user cannot see is a memory they cannot correct. Confirmation is what
    // decides whether it is used, not visibility.
    const memories = await db.memory.findMany({
      // Everything is listed, including what the assistant inferred: a memory
      // the user cannot see is one they cannot correct. The tool-facing search
      // still keeps them out of its own results — that is a different question.
      where: {
        ...(parsed.data.view === "confirmed" ? { confirmed: true } : {}),
        ...(parsed.data.view === "candidates" ? { confirmed: false } : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: parsed.data.limit,
    });

    return Response.json({ data: memories });
  } catch (error) {
    console.error("/api/knowledge GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch knowledge entries");
  }
}

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
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

    return Response.json({ data: memory }, { status: 201 });
  } catch (error) {
    console.error("/api/knowledge POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to save knowledge entry");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
