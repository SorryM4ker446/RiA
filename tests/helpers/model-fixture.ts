import type { Page } from "@playwright/test";
import { browserApi } from "./browser-api";

const fixtureModels = {
  chat: ["anthropic/claude-opus-4.6", "google/gemini-3-flash-preview"],
  image: ["google/gemini-3.1-flash-image-preview"],
  video: ["bytedance/seedance-2.0"],
  embedding: ["openai/text-embedding-3-small"],
} as const;

// Every fixture model is reached through the same offline provider, which is
// what the local library stores alongside the id.
const modelRef = (modelId: string) => ({ providerId: "openrouter" as const, modelId });

/** A library row shaped exactly as the settings page reads it. */
export function fixtureLibraryItem(modelId: string, modes: ("chat" | "image" | "video" | "embedding")[], overrides: Record<string, unknown> = {}) {
  return {
    providerId: "openrouter", modelId, name: modelId, description: "Fixture",
    modes, supportsImageInput: true, endpointImageInput: null, supportsTools: modes.includes("chat"),
    contextLength: null, pricing: {}, addedAt: "2026-08-30T00:00:00.000Z", lastSeenAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The `/api/models` response the settings page and the chat preferences hook
 * read: provider-qualified selections, a per-entry availability map, and the
 * provider list. Selections are sparse — an unset mode stays null.
 */
export function modelsRouteFixture(
  library: ReturnType<typeof fixtureLibraryItem>[],
  selected: { chat?: string | null; chatFallback?: string | null; image?: string | null; video?: string | null; embedding?: string | null } = {},
) {
  const libraryItem = (modelId: string | null | undefined) => (modelId ? library.find((item) => item.modelId === modelId) : undefined);
  return {
    data: {
      version: 3,
      callLimits: { maxConcurrent: 4, backgroundDailyCalls: 20, backgroundMaxEstimatedUsd: null, backgroundDailyEstimatedUsd: null, timeZone: "Asia/Shanghai" },
      defaultMode: "chat",
      chat: { model: libraryItem(selected.chat) ? modelRef(selected.chat!) : null, fallback: libraryItem(selected.chatFallback) ? modelRef(selected.chatFallback!) : null },
      image: { model: libraryItem(selected.image) ? modelRef(selected.image!) : null, fallback: null },
      video: { model: libraryItem(selected.video) ? modelRef(selected.video!) : null, fallback: null },
      embedding: libraryItem(selected.embedding) ? modelRef(selected.embedding!) : null,
      legacyCandidates: [],
      library,
      rates: {},
      backupRetentionDays: 30,
      backupMaxCount: 10,
    },
    availability: Object.fromEntries(library.map((item) => [`${item.providerId}:${item.modelId}`, { state: "ready", reason: null }])),
    providers: [{ providerId: "openrouter", displayName: "OpenRouter", configured: true }],
    recentFailures: [],
  };
}

/** Loads official-catalog-shaped offline records into the real model library. */
export async function configureOfflineModels(
  page: Page,
  options: { chat?: string; chatFallback?: string; image?: string; video?: string; embedding?: string } = {},
) {
  for (const [mode, ids] of Object.entries(fixtureModels)) {
    const refreshed = await browserApi(page, "/api/models/catalog", "POST", { mode });
    if (refreshed.status !== 200) throw new Error(`Could not load offline ${mode} catalog (${refreshed.status})`);
    for (const modelId of ids) {
      const added = await browserApi(page, "/api/models/library", "POST", { action: "add", model: modelRef(modelId) });
      if (added.status !== 200) throw new Error(`Could not add offline model ${modelId} (${added.status})`);
    }
  }
  const response = await browserApi(page, "/api/models");
  if (response.status !== 200) throw new Error(`Could not load model preferences (${response.status})`);
  const settings = response.body.data;
  if (options.chat !== undefined) settings.chat.model = modelRef(options.chat);
  if (options.chatFallback !== undefined) settings.chat.fallback = modelRef(options.chatFallback);
  if (options.image !== undefined) settings.image.model = modelRef(options.image);
  if (options.video !== undefined) settings.video.model = modelRef(options.video);
  if (options.embedding !== undefined) settings.embedding = modelRef(options.embedding);
  if (Object.values(options).some(Boolean)) {
    const saved = await browserApi(page, "/api/models", "PUT", settings);
    if (saved.status !== 200) throw new Error(`Could not save offline model preferences (${saved.status})`);
    // The chat preferences hook reads account defaults on mount.
    await page.reload();
  }
}
