import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { BodyReadError, readLimitedJson } from "@/lib/models/catalog-read";
import { libraryModes } from "@/lib/models/preferences-schema";
import { CatalogFetchError, type CatalogModel, type ModelProvider } from "@/lib/models/providers/types";

const catalogMaxBodyBytes = 8 * 1024 * 1024;
const openrouter = createOpenRouter({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: {
    ...(process.env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER } : {}),
    ...((process.env.OPENROUTER_SITE_NAME ?? process.env.OPENROUTER_X_TITLE)
      ? { "X-OpenRouter-Title": process.env.OPENROUTER_SITE_NAME ?? process.env.OPENROUTER_X_TITLE! }
      : {}),
  },
});

function openRouterKey() {
  return process.env.OPENROUTER_API_KEY?.trim() ?? "";
}

// OpenRouter ids are `author/name`. This shape lives with the adapter because it
// is OpenRouter's convention; no other provider has to learn it.
const openRouterModelIdSchema = z.string().max(200).regex(/^[a-zA-Z0-9][\w.-]{0,99}\/[a-zA-Z0-9][\w.:+-]{0,159}$/);

const rawModel = z.object({
  id: z.string().min(1).max(200), name: z.string().max(240).nullable().optional(), description: z.string().max(2000).nullable().optional(),
  context_length: z.number().int().positive().nullable().optional(),
  architecture: z.object({ modality: z.string().optional(), input_modalities: z.array(z.string()).optional(), output_modalities: z.array(z.string()).optional() }).passthrough().nullable().optional(),
  supported_parameters: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).nullable().optional(),
  supported_frame_images: z.array(z.string()).nullable().optional(),
  supported_durations: z.array(z.unknown()).nullable().optional(),
  supported_resolutions: z.array(z.unknown()).nullable().optional(),
  supported_aspect_ratios: z.array(z.unknown()).nullable().optional(),
  pricing: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullable().optional(),
  pricing_skus: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullable().optional(),
}).passthrough();

const catalogEnvelope = z.object({ data: z.array(z.unknown()).max(20_000) }).passthrough();

function hasPositiveReferenceLimit(value: unknown) {
  if (value === true) return true;
  if (!value || typeof value !== "object") return false;
  const max = (value as { max?: unknown }).max;
  return typeof max === "number" && max > 0;
}

function normalizeOpenRouterRow(value: unknown, mode: (typeof libraryModes)[number]): CatalogModel | null {
  const parsed = rawModel.safeParse(value);
  if (!parsed.success || !openRouterModelIdSchema.safeParse(parsed.data.id).success) return null;
  const row = parsed.data;
  const modality = row.architecture?.modality?.toLowerCase().split("->");
  const inputs = (row.architecture?.input_modalities ?? modality?.[0]?.split("+") ?? []).map(value => value.toLowerCase());
  const outputs = (row.architecture?.output_modalities ?? modality?.at(-1)?.split("+") ?? []).map(value => value.toLowerCase());
  const parameters = row.supported_parameters ?? [];
  const parameterNames = Array.isArray(parameters) ? parameters : Object.keys(parameters);
  const frameImages = row.supported_frame_images ?? [];
  if (mode === "chat" && !outputs.includes("text")) return null;
  return {
    providerId: "openrouter",
    modelId: row.id,
    name: row.name?.trim() || row.id,
    description: row.description?.slice(0, 2000) ?? "",
    modes: [mode],
    supportsImageInput: mode === "video"
      ? frameImages.length > 0
      : inputs.includes("image") || parameterNames.some(x => ["image", "input_image", "frame_images", "input_references"].includes(x)),
    endpointImageInput: null,
    supportsTools: mode === "chat" && parameterNames.some(x => ["tools", "tool_choice"].includes(x)),
    // Three ways the provider says it will search on its own: the `:online`
    // variant of any slug, a per-request search-context price, or a declared
    // web search parameter. Any of them means the answer is grounded by the
    // provider and billed for it, which the user is told rather than left to
    // discover on an invoice.
    providerSearch: /:online$/.test(row.id) || Object.keys(row.pricing ?? row.pricing_skus ?? {}).some(key => key.includes("search")) || parameterNames.some(x => /web[_-]?search/i.test(x)),
    contextLength: row.context_length ?? null,
    pricing: Object.fromEntries(Object.entries(row.pricing ?? row.pricing_skus ?? {}).filter(([, v]) => ["string", "number"].includes(typeof v)).slice(0, 12).map(([k, v]) => [k, String(v)])),
  };
}

const openRouterCatalogUrls: Record<(typeof libraryModes)[number], string> = {
  chat: "https://openrouter.ai/api/v1/models?output_modalities=text",
  image: "https://openrouter.ai/api/v1/images/models",
  video: "https://openrouter.ai/api/v1/videos/models",
  embedding: "https://openrouter.ai/api/v1/embeddings/models",
};

async function fetchOpenRouterCatalog(mode: (typeof libraryModes)[number], signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(openRouterCatalogUrls[mode], {
      method: "GET", cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", ...(openRouterKey() ? { Authorization: `Bearer ${openRouterKey()}` } : {}) },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new CatalogFetchError("timeout");
    throw new CatalogFetchError("network");
  }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new CatalogFetchError("unauthorized", String(response.status)); }
  if (!response.ok) { await response.body?.cancel(); throw new CatalogFetchError("http", String(response.status)); }

  let decoded: unknown;
  try { decoded = await readLimitedJson(response, catalogMaxBodyBytes); }
  catch (error) {
    if (error instanceof BodyReadError) throw new CatalogFetchError(error.failure);
    // A body that stops arriving is this machine's connection failing, not a
    // response OpenRouter returned in a shape it did not intend. Reporting it
    // as a malformed catalog tells the user their provider is sending
    // something broken, and the reason is kept against the cached snapshot.
    if (error instanceof Error && error.name === "AbortError") throw new CatalogFetchError("timeout");
    throw new CatalogFetchError("network");
  }

  const envelope = catalogEnvelope.safeParse(decoded);
  if (!envelope.success) throw new CatalogFetchError("invalidShape");
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  let invalidRows = 0;
  // A handful of malformed or duplicated rows is normal for a live third-party
  // feed and says nothing about the rows that parsed cleanly. Discarding the
  // whole catalog over a few bad entries reported "unavailable" with zero
  // models while the rest were perfectly usable, so the count travels back as
  // a warning and only an entirely empty result is a failure.
  for (const value of envelope.data.data) {
    const item = normalizeOpenRouterRow(value, mode);
    if (!item || seen.has(item.modelId)) { invalidRows++; continue; }
    seen.add(item.modelId);
    models.push(item);
  }
  if (models.length === 0) throw new CatalogFetchError("emptyCatalog", invalidRows ? String(invalidRows) : undefined);
  return { models, invalidRows };
}

export const openRouterProvider: ModelProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  isTrustedModelId: (value) => openRouterModelIdSchema.safeParse(value).success,
  offeredModes: ["chat", "image", "video", "embedding"],
  isConfigured: () => Boolean(openRouterKey()),
  fetchCatalog: fetchOpenRouterCatalog,
  createChatModel: (modelId) => openrouter(modelId),
  createImageModel: (modelId) => openrouter.imageModel(modelId),
  createVideoModel: (modelId) => openrouter.videoModel(modelId),
  createEmbeddingModel: (modelId) => openrouter.textEmbeddingModel(modelId),
  probeImageInput: async (modelId) => {
    if (!openRouterModelIdSchema.safeParse(modelId).success) return null;
    const [author, slug] = modelId.split("/");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/images/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`, {
        method: "GET", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", ...(openRouterKey() ? { Authorization: `Bearer ${openRouterKey()}` } : {}) },
      });
      if (!response.ok) return null;
      const decoded = await readLimitedJson(response, 2 * 1024 * 1024);
      const parsed = z.object({ endpoints: z.array(z.object({ supported_parameters: z.record(z.string(), z.unknown()).optional() }).passthrough()).max(500) }).safeParse(decoded);
      if (!parsed.success || !parsed.data.endpoints.length) return false;
      return parsed.data.endpoints.some(endpoint => hasPositiveReferenceLimit(endpoint.supported_parameters?.input_references));
    } catch { return null; }
    finally { clearTimeout(timer); }
  },
};
