import { z } from "zod";
import { ASSET_ID_PATTERN } from "@/lib/media/message-codec";

const input = z.strictObject({ assetId: z.string().regex(ASSET_ID_PATTERN), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]) });
export const generationRecipeSchema = z.discriminatedUnion("type", [
  z.strictObject({ version: z.literal(1), type: z.literal("image"), modelId: z.string().min(1).max(200), prompt: z.string().max(4000), inputImages: z.array(input).max(4) }),
  z.strictObject({ version: z.literal(1), type: z.literal("video"), modelId: z.string().min(1).max(200), prompt: z.string().max(4000), inputImages: z.array(input).max(1), aspectRatio: z.enum(["16:9", "9:16", "1:1"]), duration: z.number().int().min(1).max(60).optional(), fps: z.number().int().min(1).max(120).optional() }),
]);
export type GenerationRecipe = z.infer<typeof generationRecipeSchema>;
export function readGenerationRecipe(value: unknown): GenerationRecipe | null {
  const result = generationRecipeSchema.safeParse(value);
  return result.success ? result.data : null;
}
