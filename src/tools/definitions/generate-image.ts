import { z } from "zod";
import type { ModelMessage, ToolResultPart } from "ai";
import { MEDIA_LIMITS } from "@/lib/media/limits-constants";
import { ASSET_ID_PATTERN } from "@/lib/media/message-codec";
import { imageAspectRatioSchema } from "@/lib/media/generation-recipe";
import { autoReviewSchema } from "@/lib/approvals/auto-review-schema";

/*
 * Making a picture from the conversation. The chat model writes the whole
 * description, since the image model sees nothing else, and names the
 * pictures to build on by their media ids, which the conversation shows next
 * to every image it holds. The picture is stored like any other generated
 * image and shown in the answer; the call's result says where it is.
 */

export const GENERATE_IMAGE_DESCRIPTION = "Make a picture with the user's image model; it is shown to the user in the conversation. Whether to use it is your judgement; the test is whether the user wants a picture made or changed, rather than words about one. Use it for: \"draw a cat in a spacesuit\" (a picture asked for); \"make me a poster for Friday's talk\" (the result is a picture); \"now make the background night\" after a picture (a change: pass that picture in referenceImages). Skip it for: \"how do I draw a cat?\" or \"what makes a good poster?\" (questions to answer in words); a diagram or chart you can write as Mermaid or a table; a picture the user did not ask for. Write prompt as the complete description the image model needs, since it sees nothing else: subject, style, composition, any text to appear in the picture, and everything from the conversation it depends on. To change or build on pictures, put their media ids in referenceImages: each image in the conversation, attached or made earlier, shows its media id. aspectRatio is optional, such as 16:9 or 1:1. Each call costs money: it waits for the user's approval unless their latest message asks for the picture or the conversation has full access. The result gives the new picture's media id. If the result includes the actual image, check it against what was asked and call once more with a corrected prompt if it plainly misses. If no image is attached, keep your reply to a brief confirmation. When the user asks to inspect the result, also say that you cannot verify it. Leave both the prompt and all visual details out of this reply. The user already sees the picture, so keep any description brief and omit the link.";

const generateImageFields = z.strictObject({
  prompt: z.string().trim().min(1).max(4000).describe("The complete description for the image model, with everything from the conversation it needs."),
  referenceImages: z.array(z.string().regex(ASSET_ID_PATTERN, "a media id shown in the conversation")).max(MEDIA_LIMITS.attachmentCount).optional()
    .describe(`Media ids of pictures to change or build on, at most ${MEDIA_LIMITS.attachmentCount}.`),
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
export async function runGenerateImage(input: GenerateImageInput, context: { chatId?: string | null; signal?: AbortSignal; background?: boolean }): Promise<GenerateImageOutput> {
  context.signal?.throwIfAborted();
  // Loaded here: the generation service reads the request schemas, which list the built-in tools.
  const { generateStoredMedia } = await import("@/lib/media/generation");
  const { mediaUrl } = await import("@/lib/media/message-codec");
  const referenceImages = [...new Set(input.referenceImages ?? [])];
  const result = await generateStoredMedia("image", {
    prompt: input.prompt,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    inputImages: referenceImages.map(id => ({ url: mediaUrl(id) })),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
  }, context.signal ?? new AbortController().signal, { background: context.background });
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
