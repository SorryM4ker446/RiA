import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { getMediaDetail } from "@/lib/media/library";
import { generateStoredMedia } from "@/lib/media/generation";
import { mediaUrl } from "@/lib/media/message-codec";
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("mediaRegeneration", user.id);
    z.strictObject({ confirm: z.literal(true) }).parse(await readJsonBody(req, 16 * 1024));
    const detail = await getMediaDetail(user.id, (await context.params).id);
    if (detail.regenerationUnavailable || !detail.generation) throw new ApiError({ code: "CONFLICT", message: detail.regenerationUnavailable ?? "生成参数不可用。" });
    const recipe = detail.generation;
    enforceRateLimit(recipe.type, user.id);
    const inputs = recipe.inputImages.map(image => ({ url: mediaUrl(image.assetId), mediaType: image.mediaType }));
    const body = { prompt: recipe.prompt, modelId: recipe.modelId, ...(detail.sourceChat ? { chatId: detail.sourceChat.id } : {}),
      ...(recipe.type === "image" ? { inputImages: inputs } : { inputImage: inputs[0], aspectRatio: recipe.aspectRatio, duration: recipe.duration, fps: recipe.fps }) };
    return Response.json(await generateStoredMedia(user.id, recipe.type, body, req.signal), { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, "重新生成失败，原资源已保留。"); }
}
