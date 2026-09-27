import type { Page } from "@playwright/test";
import { browserApi } from "./browser-api";

const fixtureModels = {
  chat: ["anthropic/claude-opus-4.6", "google/gemini-3-flash-preview"],
  image: ["google/gemini-3.1-flash-image-preview"],
  video: ["bytedance/seedance-2.0"],
  embedding: ["openai/text-embedding-3-small"],
} as const;

/** Loads official-catalog-shaped offline records into the real model library. */
export async function configureOfflineModels(
  page: Page,
  options: { chat?: string; chatFallback?: string; image?: string; video?: string; embedding?: string } = {},
) {
  for (const [mode, ids] of Object.entries(fixtureModels)) {
    const refreshed = await browserApi(page, "/api/models/catalog", "POST", { mode });
    if (refreshed.status !== 200) throw new Error(`Could not load offline ${mode} catalog (${refreshed.status})`);
    for (const modelId of ids) {
      const added = await browserApi(page, "/api/models/library", "POST", { action: "add", modelId });
      if (added.status !== 200) throw new Error(`Could not add offline model ${modelId} (${added.status})`);
    }
  }
  const response = await browserApi(page, "/api/models");
  if (response.status !== 200) throw new Error(`Could not load model preferences (${response.status})`);
  const settings = response.body.data;
  if (options.chat !== undefined) settings.chat.modelId = options.chat;
  if (options.chatFallback !== undefined) settings.chat.fallbackId = options.chatFallback;
  if (options.image !== undefined) settings.image.modelId = options.image;
  if (options.video !== undefined) settings.video.modelId = options.video;
  if (options.embedding !== undefined) settings.embeddingModelId = options.embedding;
  if (Object.values(options).some(Boolean)) {
    const saved = await browserApi(page, "/api/models", "PUT", settings);
    if (saved.status !== 200) throw new Error(`Could not save offline model preferences (${saved.status})`);
    // The chat preferences hook reads account defaults on mount.
    await page.reload();
  }
}
