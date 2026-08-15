import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { getRelevantMemories } from "@/lib/memory/store";
import { createApiErrorResponse } from "@/lib/server/api-error";

const retrievalSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);

    const parsed = retrievalSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid retrieval request",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      );
    }

    const memories = await getRelevantMemories({
      userId: user.id,
      query: parsed.data.query,
      limit: parsed.data.limit ?? 6,
    });

    return Response.json({ data: memories });
  } catch (error) {
    console.error("/api/retrieval POST error", error);
    return createApiErrorResponse(error, "Failed to retrieve memories");
  }
}
