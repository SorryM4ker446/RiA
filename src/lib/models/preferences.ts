import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { availableModel, defaultModelPreferences, modelModes, preferencesSchema, type GenerationMode } from "@/lib/models/preferences-schema";
export async function getModelPreferences(userId: string) {
  const record = await db.accountPreference.findUnique({ where: { userId } });
  return record ? preferencesSchema.parse(record.settings) : defaultModelPreferences();
}
export async function saveModelPreferences(userId: string, value: unknown) {
  const settings = preferencesSchema.parse(value);
  for (const mode of modelModes) {
    const preference = settings[mode];
    if (!availableModel(mode, preference.modelId) || (preference.fallbackId && (!availableModel(mode, preference.fallbackId) || preference.fallbackId === preference.modelId))) throw new ApiError({ code: "VALIDATION_ERROR", message: "请选择当前目录中的主模型和不同的备用模型。" });
  }
  await db.accountPreference.upsert({ where: { userId }, create: { userId, settings }, update: { settings } });
  return settings;
}
export async function preferredModel(userId: string, mode: GenerationMode, supplied?: string) {
  const id = supplied ?? (await getModelPreferences(userId))[mode].modelId;
  if (!availableModel(mode, id)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "保存的模型已不在目录中，请在模型设置中重新选择。" });
  return id;
}
