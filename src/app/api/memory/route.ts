import { NextRequest } from "next/server";
import { z } from "zod";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { getRelevantMemories, saveMemory } from "@/lib/memory/store";

const saveMemorySchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  score: z.number().min(0).max(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getOrCreateRequestUser(req);
    const query = req.nextUrl.searchParams.get("query")?.trim() ?? "";
    const limitRaw = req.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 5;

    if (!query) {
      return Response.json({ data: [], message: "query is empty" });
    }

    const memories = await getRelevantMemories({
      userId: user.id,
      query,
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 20)) : 5,
    });

    return Response.json({ data: memories });
  } catch (error) {
    console.error("/api/memory GET error", error);
    return Response.json({ error: "Failed to fetch memories" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getOrCreateRequestUser(req);
    const parsed = saveMemorySchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const memory = await saveMemory({
      userId: user.id,
      key: parsed.data.key,
      value: parsed.data.value,
      score: parsed.data.score,
    });

    return Response.json({ data: memory }, { status: 201 });
  } catch (error) {
    console.error("/api/memory POST error", error);
    return Response.json({ error: "Failed to save memory" }, { status: 500 });
  }
}
