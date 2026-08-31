import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { generateStoredMedia } from "@/lib/media/generation";

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("image", user.id);
    return Response.json(await generateStoredMedia(user.id, "image", await readJsonBody(req), req.signal), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, "媒体生成或保存失败，请稍后重试。"); }
}
