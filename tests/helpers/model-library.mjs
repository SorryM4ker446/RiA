import { DEFAULT_IMAGE_MODEL, DEFAULT_MODEL, DEFAULT_VIDEO_MODEL, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS, OPENROUTER_VIDEO_MODELS } from "../../src/config/model.ts";
import { defaultModelPreferences } from "../../src/lib/models/preferences-schema.ts";

const now = new Date().toISOString();
const rows = [
  ...OPENROUTER_MODELS.map(model => ({ ...model, modes: ["chat"], endpointImageInput: null })),
  ...OPENROUTER_IMAGE_MODELS.map(model => ({ ...model, modes: ["image"], endpointImageInput: true })),
  ...OPENROUTER_VIDEO_MODELS.map(model => ({ ...model, modes: ["video"], endpointImageInput: null })),
  ].map(({ id, label, modes, supportsImageInput, supportsTools = modes.includes("chat"), contextLength = null, description = "Test model", pricing = {}, endpointImageInput }) => ({
  providerId: "openrouter", modelId: id, name: label, description, modes, supportsImageInput, endpointImageInput, supportsTools, contextLength, pricing, addedAt: now, lastSeenAt: now,
}));

// Selections are provider-qualified, so a seeded default carries both halves.
// The tests use these through the same shape the interface sends.
export const CHAT_MODEL_REF = { providerId: "openrouter", modelId: DEFAULT_MODEL };
export const IMAGE_MODEL_REF = { providerId: "openrouter", modelId: DEFAULT_IMAGE_MODEL };
export const VIDEO_MODEL_REF = { providerId: "openrouter", modelId: DEFAULT_VIDEO_MODEL };

export async function seedTestModelPreferences(db) {
  const settings = defaultModelPreferences();
  settings.chat.model = CHAT_MODEL_REF;
  settings.image.model = IMAGE_MODEL_REF;
  settings.video.model = VIDEO_MODEL_REF;
  settings.library = rows;
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
  return settings;
}
