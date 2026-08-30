import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { searchDocuments } from "@/lib/documents/retrieval";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";

const schema = z.strictObject({ query: z.string().trim().min(1).max(2000) });
export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("tools", user.id);
    const { query } = schema.parse(await readJsonBody(req));
    return Response.json({ data: await searchDocuments(user.id, query, 6) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "检索文档失败。"); }
}
