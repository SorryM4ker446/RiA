import { generateImage } from "ai";
import { NextRequest } from "next/server";
import { imageModelSupportsImageInput, resolveImageModelId } from "@/config/model";
import { getImageModel } from "@/lib/ai/client";
import { setupServerProxy } from "@/lib/server/proxy";

type ImageRequestBody = {
  prompt?: string;
  modelId?: string;
  size?: `${number}x${number}`;
  inputImages?: Array<{
    url: string;
    mediaType?: string;
  }>;
};

function extractImageError(error: unknown): { status: number; message: string } {
  const fallback = { status: 500, message: "图片生成失败，请稍后重试。" };

  if (!error || typeof error !== "object") {
    return fallback;
  }

  const candidate = error as {
    message?: unknown;
    statusCode?: unknown;
    responseBody?: unknown;
  };

  const statusCode =
    typeof candidate.statusCode === "number" && candidate.statusCode >= 400 && candidate.statusCode < 600
      ? candidate.statusCode
      : 500;

  if (statusCode === 429) {
    return {
      status: 429,
      message: "图片生成请求过于频繁，或账户额度不足，请稍后重试。",
    };
  }

  if (typeof candidate.responseBody === "string" && candidate.responseBody.trim()) {
    try {
      const parsed = JSON.parse(candidate.responseBody) as {
        error?: { message?: unknown };
        message?: unknown;
      };

      const upstreamMessage =
        typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : null;

      if (upstreamMessage) {
        return {
          status: statusCode,
          message: `图片生成失败：${upstreamMessage}`,
        };
      }
    } catch {
      // Keep fallback below.
    }
  }

  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return {
      status: statusCode,
      message: `图片生成失败：${candidate.message}`,
    };
  }

  return fallback;
}

export async function POST(req: NextRequest) {
  try {
    setupServerProxy();

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      return Response.json(
        {
          error:
            "OPENROUTER_API_KEY is not configured. Set it in .env and restart the dev server before generating images.",
        },
        { status: 500 },
      );
    }

    const body = (await req.json()) as ImageRequestBody;
    const prompt = body.prompt?.trim();
    const inputImages = Array.isArray(body.inputImages)
      ? body.inputImages
          .filter((image) => image && typeof image.url === "string" && image.url.length > 0)
          .map((image) => image.url)
      : [];

    if (!prompt && inputImages.length === 0) {
      return Response.json({ error: "prompt or inputImages is required" }, { status: 400 });
    }

    const modelId = resolveImageModelId(body.modelId);
    if (inputImages.length > 0 && !imageModelSupportsImageInput(modelId)) {
      return Response.json(
        { error: `当前图像模型 ${modelId} 不支持参考图输入，请更换支持图像编辑的模型。` },
        { status: 400 },
      );
    }

    const result = await generateImage({
      model: getImageModel(modelId),
      prompt:
        inputImages.length > 0
          ? {
              images: inputImages,
              ...(prompt ? { text: prompt } : {}),
            }
          : (prompt as string),
      n: 1,
    });

    const image = result.image;
    return Response.json({
      modelId,
      dataUrl: `data:${image.mediaType};base64,${image.base64}`,
    });
  } catch (error) {
    console.error("/api/image error", error);
    const extracted = extractImageError(error);
    return Response.json({ error: extracted.message }, { status: extracted.status });
  }
}
