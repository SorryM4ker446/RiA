import { experimental_generateVideo } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveVideoModelId, videoModelSupportsImageInput } from "@/config/model";
import { getVideoModel } from "@/lib/ai/client";
import { requireRequestUser } from "@/lib/auth/request-user";
import { imageInputBytes } from "@/lib/media/messages";
import { createMediaAsset, toMediaReference } from "@/lib/media/storage";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { setupServerProxy } from "@/lib/server/proxy";

const videoRequestSchema = z.object({
  prompt: z.string().trim().max(4000).default(""), modelId: z.string().max(200).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  duration: z.number().min(1).max(60).optional(), fps: z.number().int().min(1).max(120).optional(),
  inputImage: z.object({ url: z.string().max(200), mediaType: z.string().max(100).optional() }).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const body = videoRequestSchema.parse(await readJsonBody(req));
    if (!body.prompt && !body.inputImage) throw new ApiError({ code: "VALIDATION_ERROR", message: "prompt or inputImage is required" });
    const [inputImage] = await imageInputBytes(user.id, body.inputImage ? [body.inputImage] : []);
    const modelId = resolveVideoModelId(body.modelId);
    if (inputImage && !videoModelSupportsImageInput(modelId)) throw new ApiError({ code: "VALIDATION_ERROR", message: "当前视频模型不支持图片输入。" });
    if (!process.env.OPENROUTER_API_KEY?.trim()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "OpenRouter API key is not configured" });
    setupServerProxy();
    const result = await experimental_generateVideo({
      model: getVideoModel(modelId), n: 1, abortSignal: req.signal,
      prompt: inputImage ? { image: inputImage, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt,
      aspectRatio: body.aspectRatio, duration: body.duration, fps: body.fps,
    });
    const asset = await createMediaAsset({
      userId: user.id, bytes: result.video.uint8Array, mediaType: result.video.mediaType,
      kind: "generated-video", modelId, description: body.prompt,
    });
    return Response.json({ modelId, asset: toMediaReference(asset) });
  } catch (error) {
    if (error instanceof ApiError || error instanceof z.ZodError) return createApiErrorResponse(error);
    return createApiErrorResponse(new ApiError({ code: "UPSTREAM_FAILED", message: "视频生成或保存失败，请稍后重试。" }));
  }
}
