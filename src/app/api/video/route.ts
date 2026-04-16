import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { experimental_generateVideo } from "ai";
import { NextRequest } from "next/server";
import { resolveVideoModelId, videoModelSupportsImageInput } from "@/config/model";
import { getVideoModel } from "@/lib/ai/client";
import { setupServerProxy } from "@/lib/server/proxy";

type VideoRequestBody = {
  prompt?: string;
  modelId?: string;
  aspectRatio?: `${number}:${number}`;
  duration?: number;
  fps?: number;
  inputImage?: {
    url: string;
    mediaType?: string;
  };
};

function getVideoExtension(mediaType: string): string {
  if (mediaType.includes("mp4")) return "mp4";
  if (mediaType.includes("webm")) return "webm";
  if (mediaType.includes("quicktime")) return "mov";
  return "mp4";
}

export async function POST(req: NextRequest) {
  try {
    setupServerProxy();

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      return Response.json(
        {
          error:
            "OPENROUTER_API_KEY is not configured. Set it in .env and restart the dev server before generating videos.",
        },
        { status: 500 },
      );
    }

    const body = (await req.json()) as VideoRequestBody;
    const prompt = body.prompt?.trim();
    const inputImage =
      body.inputImage && typeof body.inputImage.url === "string" && body.inputImage.url.length > 0
        ? body.inputImage.url
        : null;

    if (!prompt && !inputImage) {
      return Response.json({ error: "prompt or inputImage is required" }, { status: 400 });
    }

    const modelId = resolveVideoModelId(body.modelId);
    if (inputImage && !videoModelSupportsImageInput(modelId)) {
      return Response.json(
        { error: `当前视频模型 ${modelId} 不支持图片输入，请切换模型后重试。` },
        { status: 400 },
      );
    }

    const result = await experimental_generateVideo({
      model: getVideoModel(modelId),
      prompt: inputImage
        ? {
            image: inputImage,
            ...(prompt ? { text: prompt } : {}),
          }
        : (prompt as string),
      n: 1,
      aspectRatio: body.aspectRatio ?? "16:9",
      ...(typeof body.duration === "number" ? { duration: body.duration } : {}),
      ...(typeof body.fps === "number" ? { fps: body.fps } : {}),
    });

    const video = result.video;
    const extension = getVideoExtension(video.mediaType);
    const fileName = `${Date.now()}-${randomUUID()}.${extension}`;
    const outputDir = path.join(process.cwd(), "public", "generated-videos");
    const outputPath = path.join(outputDir, fileName);

    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, Buffer.from(video.uint8Array));

    return Response.json({
      modelId,
      videoUrl: `/generated-videos/${fileName}`,
      mediaType: video.mediaType,
    });
  } catch (error) {
    console.error("/api/video error", error);
    return Response.json({ error: "Failed to generate video" }, { status: 500 });
  }
}
