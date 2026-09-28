import { z } from "zod";
import { t } from "@/lib/locale";

export const modelModes = ["chat", "image", "video"] as const;
export const libraryModes = [...modelModes, "embedding"] as const;
export type GenerationMode = typeof modelModes[number];
export type LibraryMode = typeof libraryModes[number];

/**
 * The ids a stored model reference may name. A provider id is added here in the
 * same change that registers its adapter, and `providers.test` fails the build
 * if the two ever disagree — otherwise a library row could name a provider the
 * application has no protocol for.
 */
export const providerIds = ["openrouter", "deepseek"] as const;
export type ProviderId = typeof providerIds[number];
export const providerIdSchema = z.enum(providerIds);

const id = z.string().min(1).max(200);
export const modelIdSchema = z.string().min(1).max(200);
const price = z.number().min(0).max(1_000_000).nullable();

/**
 * A model is identified by the provider it is called through plus that
 * provider's own id. The two are not interchangeable: the same underlying model
 * reached through OpenRouter and reached directly are separate entries with
 * separate credentials, pricing and availability.
 */
export const modelRefSchema = z.strictObject({ providerId: providerIdSchema, modelId: modelIdSchema });
export type ModelRef = z.infer<typeof modelRefSchema>;

export function modelRefKey(ref: ModelRef) {
  return `${ref.providerId}:${ref.modelId}`;
}

function sameRef(ref: ModelRef | null | undefined, other: ModelRef | null | undefined) {
  return Boolean(ref && other && ref.providerId === other.providerId && ref.modelId === other.modelId);
}

const modePreference = z.strictObject({ model: modelRefSchema.nullable(), fallback: modelRefSchema.nullable() });

export const modelLibraryItemSchema = z.strictObject({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  name: z.string().min(1).max(240),
  description: z.string().max(2000),
  modes: z.array(z.enum(libraryModes)).min(1).max(libraryModes.length),
  supportsImageInput: z.boolean(),
  endpointImageInput: z.boolean().nullable().default(null),
  supportsTools: z.boolean(),
  /**
   * The provider performs its own web search for this model, charged on top of
   * the model's usage. Recognised rather than hidden, because an answer the
   * user paid to ground is not the same thing as one this application searched
   * for — and an entry written before this field existed means "not known".
   */
  providerSearch: z.boolean().optional(),
  contextLength: z.number().int().positive().nullable(),
  pricing: z.record(z.string().max(40), z.string().max(80)).refine(value => Object.keys(value).length <= 12),
  addedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type ModelLibraryItem = z.infer<typeof modelLibraryItemSchema>;

export const legacyModelCandidateSchema = z.strictObject({ mode: z.enum(libraryModes), ref: modelRefSchema });
const preferencesShape = {
  version: z.literal(3),
  defaultMode: z.enum(modelModes),
  chat: modePreference,
  image: modePreference,
  video: modePreference,
  embedding: modelRefSchema.nullable(),
  legacyCandidates: z.array(legacyModelCandidateSchema).max(20),
  library: z.array(modelLibraryItemSchema).max(1000).refine(rows => new Set(rows.map(row => modelRefKey(row))).size === rows.length, "Duplicate models in library"),
  // Keyed by `provider:model`, so two providers offering the same underlying
  // model keep their own user-supplied rates.
  // Cached input is priced separately because providers bill it differently.
// Both stay nullable: an unset cache rate falls back to the input rate, so an
// existing configuration keeps meaning exactly what it meant before.
  rates: z.record(id, z.strictObject({
    inputPerMillion: price,
    outputPerMillion: price,
    perRequest: price,
    cacheReadPerMillion: price.nullish(),
    cacheWritePerMillion: price.nullish(),
  })).refine(value => Object.keys(value).length <= 100),
  backupRetentionDays: z.number().int().min(1).max(365),
  backupMaxCount: z.number().int().min(2).max(20),
  /**
   * Whether the model should reason before answering, and how hard.
   *
   * It is a request-level setting, so it is stored per workspace rather than
   * per model: a model that has no notion of it ignores it. The default
   * matches what a reasoning model does on its own, so an existing workspace
   * keeps behaving the same and no stored document has to be rewritten.
   */
  thinking: z.strictObject({
    enabled: z.boolean().default(true),
    effort: z.enum(["low", "high", "max"]).nullable().default(null),
  }).default({ enabled: true, effort: null }),
};

export const preferencesSchema = z.strictObject(preferencesShape).superRefine((settings, context) => {
  const library = new Map(settings.library.map(item => [modelRefKey(item), item]));
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  for (const mode of modelModes) {
    const preference = settings[mode];
    for (const field of ["model", "fallback"] as const) {
      const ref = preference[field];
      if (ref && !library.get(modelRefKey(ref))?.modes.includes(mode)) issue([mode, field], `${t("lib.models.modelWord")} ${ref.modelId} ${t("lib.models.notYetAdded")}${mode}${t("lib.models.notYetAddedSuffix")}`);
    }
    if (preference.model && sameRef(preference.model, preference.fallback)) issue([mode, "fallback"], t("lib.models.fallbackMustDiffer"));
  }
  if (settings.embedding && !library.get(modelRefKey(settings.embedding))?.modes.includes("embedding")) issue(["embedding"], t("lib.models.embeddingNotAdded"));
});
export type ModelPreferences = z.infer<typeof preferencesSchema>;

/**
 * The library era, before model references were provider-qualified. Every entry
 * in it was reached through OpenRouter, so the conversion is a relabelling
 * rather than a guess — which is why these are read as `openrouter` and never
 * silently redirected to a direct provider.
 */
export const providerAgnosticPreferencesSchema = z.strictObject({
  version: z.literal(2),
  defaultMode: z.enum(modelModes),
  chat: z.strictObject({ modelId: z.string().max(200).nullable(), fallbackId: z.string().max(200).nullable() }),
  image: z.strictObject({ modelId: z.string().max(200).nullable(), fallbackId: z.string().max(200).nullable() }),
  video: z.strictObject({ modelId: z.string().max(200).nullable(), fallbackId: z.string().max(200).nullable() }),
  embeddingModelId: z.string().max(200).nullable(),
  legacyCandidates: z.array(legacyModelCandidateSchema).max(20).optional(),
  library: z.array(modelLibraryItemSchema).max(1000),
  rates: preferencesShape.rates,
  backupRetentionDays: preferencesShape.backupRetentionDays,
  backupMaxCount: preferencesShape.backupMaxCount,
});

export const legacyPreferencesSchema = z.strictObject({
  version: z.literal(1),
  defaultMode: z.enum(modelModes),
  chat: z.strictObject({ modelId: z.string().max(200), fallbackId: z.string().max(200).nullable() }),
  image: z.strictObject({ modelId: z.string().max(200), fallbackId: z.string().max(200).nullable() }),
  video: z.strictObject({ modelId: z.string().max(200), fallbackId: z.string().max(200).nullable() }),
  rates: preferencesShape.rates,
  backupRetentionDays: preferencesShape.backupRetentionDays,
  backupMaxCount: preferencesShape.backupMaxCount,
});

export function defaultModelPreferences(): ModelPreferences {
  return {
    version: 3,
    defaultMode: "chat",
    chat: { model: null, fallback: null },
    image: { model: null, fallback: null },
    video: { model: null, fallback: null },
    embedding: null,
    legacyCandidates: [],
    library: [],
    rates: {},
    backupRetentionDays: 30,
    backupMaxCount: 10,
    thinking: { enabled: true, effort: null },
  };
}

const ref = (modelId: string | null | undefined): ModelRef | null =>
  modelId ? { providerId: "openrouter", modelId } : null;

function upgradeProviderAgnosticSettings(legacy: z.infer<typeof providerAgnosticPreferencesSchema>): ModelPreferences {
  const modes = Object.fromEntries(modelModes.map(mode => [mode, {
    model: ref(legacy[mode].modelId),
    fallback: ref(legacy[mode].fallbackId),
  }])) as Record<GenerationMode, { model: ModelRef | null; fallback: ModelRef | null }>;

  return {
    ...defaultModelPreferences(),
    defaultMode: legacy.defaultMode,
    ...modes,
    embedding: ref(legacy.embeddingModelId),
    legacyCandidates: legacy.legacyCandidates ?? [],
    library: legacy.library,
    rates: Object.fromEntries(Object.entries(legacy.rates).map(([key, rate]) => [key.includes(":") ? key : `openrouter:${key}`, rate])),
    backupRetentionDays: legacy.backupRetentionDays,
    backupMaxCount: legacy.backupMaxCount,
  };
}

/** Converts pre-library settings into explicit migration candidates, never active models. */
export function upgradeModelPreferences(value: unknown, legacyEmbeddingModelId?: string): ModelPreferences {
  const current = preferencesSchema.safeParse(value);
  if (current.success) return current.data;

  const agnostic = providerAgnosticPreferencesSchema.safeParse(value);
  if (agnostic.success) return preferencesSchema.parse(upgradeProviderAgnosticSettings(agnostic.data));

  const legacy = legacyPreferencesSchema.safeParse(value);
  if (!legacy.success) throw new Error("Unsupported model preference schema");
  const candidates = [
    ...modelModes.flatMap(mode => [legacy.data[mode].modelId, legacy.data[mode].fallbackId]
      .filter((modelId): modelId is string => Boolean(modelId))
      .map(modelId => ({ mode, ref: { providerId: "openrouter", modelId } as ModelRef }))),
    ...(legacyEmbeddingModelId && modelIdSchema.safeParse(legacyEmbeddingModelId).success
      ? [{ mode: "embedding" as const, ref: { providerId: "openrouter", modelId: legacyEmbeddingModelId } as ModelRef }]
      : []),
  ];
  const uniqueCandidates = [...new Map(candidates.map(candidate => [`${candidate.mode}:${modelRefKey(candidate.ref)}`, candidate])).values()].slice(0, 20);
  return {
    ...defaultModelPreferences(),
    defaultMode: legacy.data.defaultMode,
    legacyCandidates: uniqueCandidates,
    rates: Object.fromEntries(Object.entries(legacy.data.rates).map(([key, rate]) => [key.includes(":") ? key : `openrouter:${key}`, rate])),
    backupRetentionDays: legacy.data.backupRetentionDays,
    backupMaxCount: legacy.data.backupMaxCount,
  };
}

export function libraryModel(preferences: ModelPreferences, mode: LibraryMode, reference: ModelRef | null | undefined) {
  if (!reference) return undefined;
  return preferences.library.find(item => item.providerId === reference.providerId && item.modelId === reference.modelId && item.modes.includes(mode));
}
