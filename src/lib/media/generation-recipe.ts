import { z } from "zod";
import { ASSET_ID_PATTERN } from "@/lib/media/message-codec";
import { providerIdSchema, type ModelRef } from "@/lib/models/preferences-schema";

const input = z.strictObject({ assetId: z.string().regex(ASSET_ID_PATTERN), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]) });

// The provider is optional so recipes written before model references were
// provider-qualified still parse. Those were all produced through OpenRouter,
// so that is what the missing field means — it is not a guess about a model
// this application has never called.
const recipeBase = {
  version: z.literal(1),
  modelId: z.string().min(1).max(200),
  modelProvider: providerIdSchema.optional(),
  prompt: z.string().max(4000),
  inputImages: z.array(input).max(4),
};

export const generationRecipeSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...recipeBase, type: z.literal("image") }),
  z.strictObject({ ...recipeBase, type: z.literal("video"), inputImages: z.array(input).max(1), aspectRatio: z.enum(["16:9", "9:16", "1:1"]), duration: z.number().int().min(1).max(60).optional(), fps: z.number().int().min(1).max(120).optional() }),
]);
export type GenerationRecipe = z.infer<typeof generationRecipeSchema>;

export function recipeModelRef(recipe: GenerationRecipe): ModelRef {
  return { providerId: recipe.modelProvider ?? "openrouter", modelId: recipe.modelId };
}

export function readGenerationRecipe(value: unknown): GenerationRecipe | null {
  const result = generationRecipeSchema.safeParse(value);
  return result.success ? result.data : null;
}
