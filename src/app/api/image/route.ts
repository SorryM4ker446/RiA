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
      size: body.size ?? "1024x1024",
    });

    const image = result.image;
    return Response.json({
      modelId,
      dataUrl: `data:${image.mediaType};base64,${image.base64}`,
    });
  } catch (error) {
    console.error("/api/image error", error);
    return Response.json({ error: "Failed to generate image" }, { status: 500 });
  }
}
