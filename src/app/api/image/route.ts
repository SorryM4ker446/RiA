import { imageRequestSchema } from "@/lib/server/request-schemas";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { generateImage } from "ai";
import { NextRequest } from "next/server";
import { imageModelSupportsImageInput, resolveImageModelId } from "@/config/model";
import { getImageModel } from "@/lib/ai/client";
import { requireRequestUser } from "@/lib/auth/request-user";
import { imageInputBytes } from "@/lib/media/messages";
import { createMediaAsset, toMediaReference } from "@/lib/media/storage";
import { ApiError, callUpstream, createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { setupServerProxy } from "@/lib/server/proxy";


export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("image", user.id);
    const body = imageRequestSchema.parse(await readJsonBody(req));
    const inputImages = await imageInputBytes(user.id, body.inputImages);
    const modelId = resolveImageModelId(body.modelId);
    if (inputImages.length && !imageModelSupportsImageInput(modelId)) throw new ApiError({ code: "VALIDATION_ERROR", message: "当前图像模型不支持参考图输入。" });
    if (!process.env.OPENROUTER_API_KEY?.trim()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "OpenRouter API key is not configured" });
    setupServerProxy();
    const result = await callUpstream(() => generateImage({
      model: getImageModel(modelId), n: 1, abortSignal: req.signal,
      prompt: inputImages.length ? { images: inputImages, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt,
    }));
    const asset = await createMediaAsset({
      userId: user.id, bytes: result.image.uint8Array, mediaType: result.image.mediaType,
      kind: "generated-image", modelId, description: body.prompt,
    });
    return Response.json({ modelId, asset: toMediaReference(asset) });
  } catch (error) {
    return createApiErrorResponse(error, "图片生成或保存失败，请稍后重试。");
  }
}
