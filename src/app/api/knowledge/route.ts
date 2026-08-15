import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { requireRequestUser } from "@/lib/auth/request-user";
import { saveMemory } from "@/lib/memory/store";

const createKnowledgeSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(4000),
  score: z.number().min(0).max(1).optional().default(0.85),
});

const knowledgeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export async function GET(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const parsed = knowledgeListQuerySchema.safeParse({
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    });

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid knowledge query",
        details: parsed.error.flatten(),
      });
    }

    const memories = await db.memory.findMany({
      where: {
        userId: user.id,
        NOT: [{ key: { startsWith: "tool:" } }],
      },
      orderBy: [{ updatedAt: "desc" }],
      take: parsed.data.limit,
    });

    return Response.json({ data: memories });
  } catch (error) {
    console.error("/api/knowledge GET error", error);
    return createApiErrorResponse(error, "Failed to fetch knowledge entries");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const parsed = createKnowledgeSchema.safeParse(await req.json());

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid knowledge entry",
        details: parsed.error.flatten(),
      });
    }

    const memory = await saveMemory({
      userId: user.id,
      key: parsed.data.key,
      value: parsed.data.value,
      score: parsed.data.score,
    });

    return Response.json({ data: memory }, { status: 201 });
  } catch (error) {
    console.error("/api/knowledge POST error", error);
    return createApiErrorResponse(error, "Failed to save knowledge entry");
  }
}
