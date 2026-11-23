import { z } from "zod";
import type { ModelMessage, ToolResultPart } from "ai";
import { MEDIA_LIMITS } from "@/lib/media/limits-constants";
import { ASSET_ID_PATTERN } from "@/lib/media/message-codec";
import { imageAspectRatioSchema } from "@/lib/media/generation-recipe";
import { autoReviewSchema } from "@/lib/approvals/auto-review-schema";
import { ApiError } from "@/lib/server/api-error";
import type { ConversationImageScope } from "@/lib/media/conversation-images";

/*
 * Making a picture from the conversation. The chat model writes the whole
 * description, since the image model sees nothing else, and names the
 * pictures to build on by their media ids, which the conversation shows next
 * to every image it holds. The picture is stored like any other generated
 * image and shown in the answer; the call's result says where it is.
 */

export const GENERATE_IMAGE_DESCRIPTION = "Make a picture with the user's image model when the user wants a picture created or changed. For a new picture (e.g. draw a cat in a spacesuit), use operation create. For a change or another picture based on an existing image (e.g. now make the background night), use operation edit and pass the actual media ids in referenceImages. If the target is unclear, ask which picture to use. A visual question about an existing picture only needs readConversationHistory with imageIds. Write a complete description for the image model, which sees only the prompt and the chosen references. Each call can cost money and follows the conversation's approval rule. The result gives the new picture's media id. If pixels reach you, check the result when the user asks. When you received only the receipt, confirm generation and say you cannot verify visual details if asked. The user already sees the picture, so keep the reply brief and omit its link and prompt.";

const generateImageFields = z.strictObject({
  prompt: z.string().trim().min(1).max(4000).describe("The complete description for the image model, with everything from the conversation it needs."),
  operation: z.enum(["create", "edit"]).optional().describe("Edit for any request to change or build on an existing image. Create for a new image from text."),
  referenceImages: z.array(z.string().regex(ASSET_ID_PATTERN, "a media id shown in the conversation")).max(MEDIA_LIMITS.referenceCount).optional()
    .describe(`Media ids of pictures to change or build on, at most ${MEDIA_LIMITS.referenceCount}.`),
  aspectRatio: imageAspectRatioSchema.optional().describe("Width to height, such as 16:9, 1:1 or 9:16. Leave it out for the model's default."),
});
/** What the model writes; the review's verdict is added by this server only. */
export const generateImageModelFields = generateImageFields;
/** A call as it is run and stored: with the review's verdict when one was given, which a resumed approval carries back. */
export const generateImageInput = generateImageFields.extend({ autoReview: autoReviewSchema.optional() });
export type GenerateImageInput = z.infer<typeof generateImageInput>;

export type GenerateImageOutput = {
  mediaId: string;
  mediaType: string;
  model: string;
  prompt: string;
  referenceImages: string[];
  aspectRatio?: string;
  note: string;
};

/** Checks the current turn's model-facing tool results, after image attachment was attempted. */
export function hasUnseenGeneratedImage(messages: ModelMessage[]) {
  const latestUser = messages.map(message => message.role).lastIndexOf("user");
  return messages.slice(latestUser + 1).some(message => message.role === "tool" && message.content.some(part => {
    if (part.type !== "tool-result" || part.toolName !== "generateImage" || part.output.type !== "json") return false;
    const value = part.output.value;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && value.status === "generated" && value.imageAttached === false;
  }));
}

/** Runs one generation for the conversation, through the same service the image mode uses. */
export async function runGenerateImage(input: GenerateImageInput, context: { chatId?: string | null; signal?: AbortSignal; background?: boolean; userText?: string; imageScope?: ConversationImageScope }): Promise<GenerateImageOutput | { skipped: "referenceRequired"; note: string }> {
  context.signal?.throwIfAborted();
  // Loaded here: the generation service reads the request schemas, which list the built-in tools.
  const { generateStoredMedia } = await import("@/lib/media/generation");
  const { mediaUrl } = await import("@/lib/media/message-codec");
  const { checkImageEdit } = await import("./image-edit-binding");
  const referenceImages = [...new Set(input.referenceImages ?? [])];
  const issue = await checkImageEdit(input, context.chatId, context.userText, context.imageScope);
  if (issue && referenceImages.length) throw new ApiError({ code: "VALIDATION_ERROR", message: issue });
  if (issue) return { skipped: "referenceRequired", note: issue };
  const result = await generateStoredMedia("image", {
    prompt: input.prompt,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    inputImages: referenceImages.map(id => ({ url: mediaUrl(id) })),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
  }, context.signal ?? new AbortController().signal, { background: context.background });
  context.imageScope?.generated.add(result.asset.assetId);
  return {
    mediaId: result.asset.assetId, mediaType: result.asset.mediaType, model: result.modelId, prompt: input.prompt, referenceImages,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    note: "The picture is shown to the user in the conversation.",
  };
}

/** Earlier image calls are represented by a receipt in model history. */
export function generatedImageReceipt(output: unknown) {
  const value = output as Partial<GenerateImageOutput> | null;
  if (!value || typeof value.mediaId !== "string" || !ASSET_ID_PATTERN.test(value.mediaId)) {
    return null;
  }
  return {
    mediaId: value.mediaId, status: "generated", imageAttached: false,
    note: "You did not receive the image. Briefly confirm that the picture is ready. If asked to inspect it, say that you cannot verify the contents without the image. Omit the drawing prompt, requested composition and visual details from your reply.",
  };
}

/** The prompt stays in the stored record. The model receives the generation outcome and any pixels sent with it. */
export async function generatedImageForModel(output: unknown, supportsImageInput = false): Promise<ToolResultPart["output"]> {
  const receipt = generatedImageReceipt(output);
  if (!receipt) return { type: "json", value: (output ?? null) as never };
  const { mediaId, status } = receipt;
  const withoutImage = { type: "json" as const, value: receipt };
  if (!supportsImageInput) return withoutImage;
  try {
    const { getMediaAsset, readMediaAsset } = await import("@/lib/media/storage");
    const asset = await getMediaAsset(mediaId);
    const bytes = await readMediaAsset(asset);
    return { type: "content" as const, value: [
      { type: "text" as const, text: JSON.stringify({ mediaId, status, imageAttached: true }) },
      { type: "image-data" as const, data: bytes.toString("base64"), mediaType: asset.mediaType },
    ] };
  } catch {
    return withoutImage;
  }
}
