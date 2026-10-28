import { DEFAULT_IMAGE_MODEL, DEFAULT_MODEL, DEFAULT_VIDEO_MODEL, OPENROUTER_IMAGE_MODELS, OPENROUTER_MODELS, OPENROUTER_VIDEO_MODELS } from "../../src/config/model";
import { defaultModelPreferences, type LibraryMode, type ModelLibraryItem, type ModelRef } from "../../src/lib/models/preferences-schema";

type CatalogEntry = {
  id: string;
  label: string;
  description: string;
  supportsImageInput: boolean;
  modes: LibraryMode[];
  endpointImageInput: boolean | null;
  supportsTools?: boolean;
  contextLength?: number | null;
  pricing?: Record<string, string>;
};

const now = new Date().toISOString();
const entries: CatalogEntry[] = [
  ...OPENROUTER_MODELS.map(model => ({ ...model, modes: ["chat"] as LibraryMode[], endpointImageInput: null })),
  ...OPENROUTER_IMAGE_MODELS.map(model => ({ ...model, modes: ["image"] as LibraryMode[], endpointImageInput: true })),
  ...OPENROUTER_VIDEO_MODELS.map(model => ({ ...model, modes: ["video"] as LibraryMode[], endpointImageInput: null })),
];
const rows: ModelLibraryItem[] = entries.map(({ id, label, modes, supportsImageInput, supportsTools = modes.includes("chat"), contextLength = null, description = "Test model", pricing = {}, endpointImageInput }) => ({
  providerId: "openrouter", modelId: id, name: label, description, modes, supportsImageInput, endpointImageInput, supportsTools, contextLength, pricing, addedAt: now, lastSeenAt: now,
}));

// Selections are provider-qualified, so a seeded default carries both halves.
// The tests use these through the same shape the interface sends.
export const CHAT_MODEL_REF: ModelRef = { providerId: "openrouter", modelId: DEFAULT_MODEL };
export const IMAGE_MODEL_REF: ModelRef = { providerId: "openrouter", modelId: DEFAULT_IMAGE_MODEL };
export const VIDEO_MODEL_REF: ModelRef = { providerId: "openrouter", modelId: DEFAULT_VIDEO_MODEL };

export async function seedTestModelPreferences(db) {
  const settings = defaultModelPreferences();
  settings.chat.model = CHAT_MODEL_REF;
  settings.image.model = IMAGE_MODEL_REF;
  settings.video.model = VIDEO_MODEL_REF;
  settings.library = rows;
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
  return settings;
}

// Search runs through the chat model's provider. DeepSeek's independent search
// endpoint follows DEEPSEEK_BASE_URL, so a loopback fixture can answer it over
// real HTTP while synthesis still uses the substituted test model.
export const SEARCH_MODEL_REF: ModelRef = { providerId: "deepseek", modelId: "deepseek-v4-flash" };

export async function seedSearchModelPreferences(db, baseURL: string) {
  process.env.DEEPSEEK_API_KEY = "offline-search-fixture";
  process.env.DEEPSEEK_BASE_URL = baseURL;
  const settings = defaultModelPreferences();
  settings.chat.model = SEARCH_MODEL_REF;
  settings.image.model = IMAGE_MODEL_REF;
  settings.video.model = VIDEO_MODEL_REF;
  settings.library = [...rows, {
    providerId: "deepseek", modelId: SEARCH_MODEL_REF.modelId, name: "DeepSeek V4 Flash", description: "Test model", modes: ["chat"],
    supportsImageInput: false, endpointImageInput: null, supportsTools: true, contextLength: null, pricing: {}, addedAt: now, lastSeenAt: now,
  }];
  await db.workspacePreference.upsert({ where: { id: "local" }, create: { id: "local", settings }, update: { settings } });
  return settings;
}
