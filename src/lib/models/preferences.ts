import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { availableModel, defaultModelPreferences, modelModes, preferencesSchema, type GenerationMode } from "@/lib/models/preferences-schema";

/**
 * Application preferences are a single row. There is one workspace, so there is
 * nothing to look up by owner.
 */
export const PREFERENCE_ROW_ID = "local";

export async function getModelPreferences() {
  const record = await db.workspacePreference.findUnique({ where: { id: PREFERENCE_ROW_ID } });
  return record ? preferencesSchema.parse(record.settings) : defaultModelPreferences();
}
export async function saveModelPreferences(value: unknown) {
  const settings = preferencesSchema.parse(value);
  for (const mode of modelModes) {
    const preference = settings[mode];
    if (!availableModel(mode, preference.modelId) || (preference.fallbackId && (!availableModel(mode, preference.fallbackId) || preference.fallbackId === preference.modelId))) throw new ApiError({ code: "VALIDATION_ERROR", message: "请选择当前目录中的主模型和不同的备用模型。" });
  }
  await db.workspacePreference.upsert({ where: { id: PREFERENCE_ROW_ID }, create: { id: PREFERENCE_ROW_ID, settings }, update: { settings } });
  return settings;
}
export async function preferredModel(mode: GenerationMode, supplied?: string) {
  const id = supplied ?? (await getModelPreferences())[mode].modelId;
  if (!availableModel(mode, id)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "保存的模型已不在目录中，请在模型设置中重新选择。" });
  return id;
}
