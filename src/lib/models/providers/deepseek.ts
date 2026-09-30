import { z } from "zod";
import { BodyReadError, readLimitedJson } from "@/lib/models/catalog-read";
import { createDeepSeekChatModel, deepSeekBaseURL, type DeepSeekThinking } from "@/lib/models/providers/deepseek-chat";
import { CatalogFetchError, type CatalogModel, type LanguageModelV3, type ModelProvider } from "@/lib/models/providers/types";
import type { LibraryMode } from "@/lib/models/preferences-schema";

export { DEEPSEEK_BASE_URL } from "@/lib/models/providers/deepseek-chat";

const catalogMaxBodyBytes = 2 * 1024 * 1024;

function deepSeekKey() {
  return process.env.DEEPSEEK_API_KEY?.trim() ?? "";
}

// DeepSeek model ids are plain slugs (`deepseek-v4-pro`). The set is discovered
// from the official endpoint, never hardcoded: an earlier alias such as
// `deepseek-chat` was renamed, and a list frozen in source would keep offering
// names the API no longer serves.
const deepSeekModelId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][\w.-]{0,199}$/);

const listedModel = z.object({
  id: z.string().min(1).max(200),
  owned_by: z.string().nullish(),
  name: z.string().nullish(),
  context_window: z.number().int().positive().nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  input_modalities: z.array(z.string()).nullish(),
  output_modalities: z.array(z.string()).nullish(),
  effort: z.object({ supported_levels: z.array(z.string()).nullish(), default_level: z.string().nullish() }).nullish(),
}).passthrough();

const catalogEnvelope = z.object({ data: z.array(z.unknown()).max(500) }).passthrough();

/**
 * Capabilities the model list does not report, stated once, with where the
 * answer came from and when it was checked.
 *
 * The rule is deliberately not folded into the catalog parser. A capability
 * that is only true because a document said so should be reviewable, and a
 * provider that later contradicts it should be visible as a contradiction
 * rather than as a silent behaviour change.
 */
export const DEEPSEEK_CAPABILITY_RULES = {
  tools: {
    supported: true,
    source: "https://api-docs.deepseek.com/guides/tool_calls",
    reviewedAt: "2026-09-28",
    note: "The official chat endpoint accepts function tools on these models. The list endpoint does not report it, so it comes from here.",
  },
  reasoningEfforts: {
    supported: ["low", "high", "max"] as const,
    source: "https://api-docs.deepseek.com/api/create-chat-completion/",
    reviewedAt: "2026-09-28",
    note: "`none` disables thinking mode and is expressed as `thinking.type=disabled` instead, so the two are never sent together.",
  },
  // The official endpoint offers no image, video or embedding model. Declaring
  // the absence is what keeps the selectors from offering a mode that could
  // only fail at call time.
  media: { supported: false, source: "https://api-docs.deepseek.com/api/list-models/", reviewedAt: "2026-09-28" },
} as const;

/**
 * Thinking mode is a property of the request, not of the model, so it lives in
 * the environment rather than in the user's model choices. The server default
 * is enabled; setting `DEEPSEEK_THINKING=disabled` turns it off, and
 * `DEEPSEEK_REASONING_EFFORT` picks the effort when it is on.
 */
export function defaultThinking(): DeepSeekThinking {
  const enabled = process.env.DEEPSEEK_THINKING?.trim().toLowerCase() !== "disabled";
  const effort = process.env.DEEPSEEK_REASONING_EFFORT?.trim().toLowerCase();
  const allowed = DEEPSEEK_CAPABILITY_RULES.reasoningEfforts.supported as readonly string[];
  return { enabled, ...(enabled && effort && allowed.includes(effort) ? { effort: effort as "low" | "high" | "max" } : {}) };
}

function normalizeRow(value: unknown): CatalogModel | null {
  const parsed = listedModel.safeParse(value);
  if (!parsed.success || !deepSeekModelId.safeParse(parsed.data.id).success) return null;
  const row = parsed.data;
  const outputs = (row.output_modalities ?? []).map(modality => modality.toLowerCase());
  // Only models that can answer in text are offered; the endpoint returns rows
  // for every family, and offering a model the chat call cannot use would put
  // the failure at send time instead of at add time.
  if (outputs.length > 0 && !outputs.includes("text")) return null;
  const inputs = (row.input_modalities ?? []).map(modality => modality.toLowerCase());
  return {
    providerId: "deepseek",
    modelId: row.id,
    name: row.name?.trim() || row.id,
    description: "",
    modes: ["chat"],
    // The list reports input modalities directly, so image input is read from
    // the provider's own field rather than inferred from a name. The chat
    // adapter implements the documented `image_url` block with an inline data
    // URL, which is what makes this claim true here rather than merely true
    // upstream; the tests exercise both halves.
    supportsImageInput: inputs.includes("image"),
    providerSupportsImageInput: inputs.includes("image"),
    endpointImageInput: null,
    supportsTools: DEEPSEEK_CAPABILITY_RULES.tools.supported,
    // This provider exposes no search of its own; searching is either the
    // application's own tool or the model's own knowledge.
    providerSearch: false,
    contextLength: row.context_window ?? null,
    // The endpoint carries no price. Cost stays unknown until the user enters
    // a rate; a price scraped from a web page would not be a bill.
    pricing: {},
  };
}

// The endpoint is a single list of chat models; there is no per-mode URL to
// point a non-chat request at, and asking for one would be a made-up request.
async function fetchDeepSeekCatalog(_mode: LibraryMode, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(`${deepSeekBaseURL()}/models`, {
      method: "GET", cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", ...(deepSeekKey() ? { Authorization: `Bearer ${deepSeekKey()}` } : {}) },
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
    // The body failing to arrive is this machine's connection, not a catalog
    // DeepSeek returned in a shape it did not intend. Reported separately from
    // a malformed one, because only one of the two is worth retrying.
    if (error instanceof Error && error.name === "AbortError") throw new CatalogFetchError("timeout");
    throw new CatalogFetchError("network");
  }

  const envelope = catalogEnvelope.safeParse(decoded);
  if (!envelope.success) throw new CatalogFetchError("invalidShape");
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  let invalidRows = 0;
  for (const value of envelope.data.data) {
    const item = normalizeRow(value);
    if (!item || seen.has(item.modelId)) { invalidRows++; continue; }
    seen.add(item.modelId);
    models.push(item);
  }
  if (models.length === 0) throw new CatalogFetchError("emptyCatalog", invalidRows ? String(invalidRows) : undefined);
  return { models, invalidRows };
}

export const deepseekProvider: ModelProvider = {
  id: "deepseek",
  displayName: "DeepSeek",
  isTrustedModelId: (value) => deepSeekModelId.safeParse(value).success,
  // Only chat. Declaring it is what makes the image, video and embedding
  // selectors stay empty instead of offering something that cannot be called.
  offeredModes: ["chat"],
  isConfigured: () => Boolean(deepSeekKey()),
  // The workspace preference is expressed in this provider's own vocabulary:
  // a toggle, an effort, and the rule that a disabled toggle and an effort are
  // never sent together.
  reasoningOptions: preference => {
    if (!preference.enabled) return { deepseek: { thinking: { enabled: false } } };
    return { deepseek: { thinking: { enabled: true, ...(preference.effort ? { effort: preference.effort } : {}) } } };
  },
  fetchCatalog: fetchDeepSeekCatalog,
  createChatModel(modelId: string): LanguageModelV3 {
    return createDeepSeekChatModel({ modelId, getApiKey: deepSeekKey, baseURL: deepSeekBaseURL(), defaultThinking: defaultThinking() });
  },
};
