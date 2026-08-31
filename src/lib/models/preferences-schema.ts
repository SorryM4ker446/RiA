import { z } from "zod";
import { DEFAULT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, OPENROUTER_MODELS, OPENROUTER_IMAGE_MODELS, OPENROUTER_VIDEO_MODELS } from "@/config/model";
export const catalogs = { chat: OPENROUTER_MODELS, image: OPENROUTER_IMAGE_MODELS, video: OPENROUTER_VIDEO_MODELS };
export type GenerationMode = keyof typeof catalogs;
export const modelModes = ["chat", "image", "video"] as const;
const id = z.string().min(1).max(200);
const mode = z.strictObject({ modelId: id, fallbackId: id.nullable() });
const price = z.number().min(0).max(1_000_000).nullable();
export const preferencesSchema = z.strictObject({
  version: z.literal(1), defaultMode: z.enum(modelModes),
  chat: mode, image: mode, video: mode,
  rates: z.record(id, z.strictObject({ inputPerMillion: price, outputPerMillion: price, perRequest: price })).refine(value => Object.keys(value).length <= 100),
  backupRetentionDays: z.number().int().min(1).max(365), backupMaxCount: z.number().int().min(2).max(20),
});
export type ModelPreferences = z.infer<typeof preferencesSchema>;
export const defaultModelPreferences = (): ModelPreferences => ({ version: 1, defaultMode: "chat", chat: { modelId: DEFAULT_MODEL, fallbackId: null }, image: { modelId: DEFAULT_IMAGE_MODEL, fallbackId: null }, video: { modelId: DEFAULT_VIDEO_MODEL, fallbackId: null }, rates: {}, backupRetentionDays: 30, backupMaxCount: 10 });
export function availableModel(mode: GenerationMode, id: string) { return catalogs[mode].find(model => model.id === id); }
