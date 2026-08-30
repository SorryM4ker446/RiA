import { generateImage } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { imageModelSupportsImageInput, resolveImageModelId } from "@/config/model";
import { getImageModel } from "@/lib/ai/client";
import { requireRequestUser } from "@/lib/auth/request-user";
import { imageInputBytes } from "@/lib/media/messages";
import { createMediaAsset, toMediaReference } from "@/lib/media/storage";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { setupServerProxy } from "@/lib/server/proxy";

const imageRequestSchema = z.object({
  prompt: z.string().trim().max(4000).default(""),
  modelId: z.string().max(200).optional(),
  inputImages: z.array(z.object({ url: z.string().max(200), mediaType: z.string().max(100).optional() })).max(4).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const body = imageRequestSchema.parse(await readJsonBody(req));
    if (!body.prompt && !body.inputImages.length) throw new ApiError({ code: "VALIDATION_ERROR", message: "prompt or inputImages is required" });
    const inputImages = await imageInputBytes(user.id, body.inputImages);
    const modelId = resolveImageModelId(body.modelId);
    if (inputImages.length && !imageModelSupportsImageInput(modelId)) throw new ApiError({ code: "VALIDATION_ERROR", message: "当前图像模型不支持参考图输入。" });
    if (!process.env.OPENROUTER_API_KEY?.trim()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "OpenRouter API key is not configured" });
    setupServerProxy();
    const result = await generateImage({
      model: getImageModel(modelId), n: 1, abortSignal: req.signal,
      prompt: inputImages.length ? { images: inputImages, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt,
    });
    const asset = await createMediaAsset({
      userId: user.id, bytes: result.image.uint8Array, mediaType: result.image.mediaType,
      kind: "generated-image", modelId, description: body.prompt,
    });
    return Response.json({ modelId, asset: toMediaReference(asset) });
  } catch (error) {
    if (error instanceof ApiError || error instanceof z.ZodError) return createApiErrorResponse(error);
    return createApiErrorResponse(new ApiError({ code: "UPSTREAM_FAILED", message: "图片生成或保存失败，请稍后重试。" }));
  }
}
