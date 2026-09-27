import { z } from "zod";
import { t } from "@/lib/locale";

export const modelModes = ["chat", "image", "video"] as const;
export const libraryModes = [...modelModes, "embedding"] as const;
export type GenerationMode = typeof modelModes[number];
export type LibraryMode = typeof libraryModes[number];

const id = z.string().min(1).max(200);
export const openRouterModelIdSchema = z.string().max(200).regex(/^[a-zA-Z0-9][\w.-]{0,99}\/[a-zA-Z0-9][\w.:+-]{0,159}$/);
const providerId = z.literal("openrouter");
const price = z.number().min(0).max(1_000_000).nullable();
const modelRef = openRouterModelIdSchema.nullable();
const modePreference = z.strictObject({ modelId: modelRef, fallbackId: modelRef });

export const modelLibraryItemSchema = z.strictObject({
  providerId,
  modelId: openRouterModelIdSchema,
  name: z.string().min(1).max(240),
  description: z.string().max(2000),
  modes: z.array(z.enum(libraryModes)).min(1).max(libraryModes.length),
  supportsImageInput: z.boolean(),
  endpointImageInput: z.boolean().nullable().default(null),
  supportsTools: z.boolean(),
  contextLength: z.number().int().positive().nullable(),
  pricing: z.record(z.string().max(40), z.string().max(80)).refine(value => Object.keys(value).length <= 12),
  addedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type ModelLibraryItem = z.infer<typeof modelLibraryItemSchema>;

export const legacyModelCandidateSchema = z.strictObject({ mode: z.enum(libraryModes), modelId: openRouterModelIdSchema });
const preferencesShape = {
  version: z.literal(2),
  defaultMode: z.enum(modelModes),
  chat: modePreference,
  image: modePreference,
  video: modePreference,
  embeddingModelId: modelRef,
  legacyCandidates: z.array(legacyModelCandidateSchema).max(20),
  library: z.array(modelLibraryItemSchema).max(1000).refine(rows => new Set(rows.map(row => `${row.providerId}:${row.modelId}`)).size === rows.length, "Duplicate models in library"),
  rates: z.record(id, z.strictObject({ inputPerMillion: price, outputPerMillion: price, perRequest: price })).refine(value => Object.keys(value).length <= 100),
  backupRetentionDays: z.number().int().min(1).max(365),
  backupMaxCount: z.number().int().min(2).max(20),
};

export const preferencesSchema = z.strictObject(preferencesShape).superRefine((settings, context) => {
  const library = new Map(settings.library.map(item => [`${item.providerId}:${item.modelId}`, item]));
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  for (const mode of modelModes) {
    const preference = settings[mode];
    for (const field of ["modelId", "fallbackId"] as const) {
      const modelId = preference[field];
      if (modelId && !library.get(`openrouter:${modelId}`)?.modes.includes(mode)) issue([mode, field], `${t("lib.models.modelWord")} ${modelId} ${t("lib.models.notYetAdded")}${mode}${t("lib.models.notYetAddedSuffix")}`);
    }
    if (preference.modelId && preference.modelId === preference.fallbackId) issue([mode, "fallbackId"], t("lib.models.fallbackMustDiffer"));
  }
  if (settings.embeddingModelId && !library.get(`openrouter:${settings.embeddingModelId}`)?.modes.includes("embedding")) issue(["embeddingModelId"], t("lib.models.embeddingNotAdded"));
});
export type ModelPreferences = z.infer<typeof preferencesSchema>;

export const legacyPreferencesSchema = z.strictObject({
  version: z.literal(1),
  defaultMode: z.enum(modelModes),
  chat: z.strictObject({ modelId: openRouterModelIdSchema, fallbackId: openRouterModelIdSchema.nullable() }),
  image: z.strictObject({ modelId: openRouterModelIdSchema, fallbackId: openRouterModelIdSchema.nullable() }),
  video: z.strictObject({ modelId: openRouterModelIdSchema, fallbackId: openRouterModelIdSchema.nullable() }),
  rates: preferencesShape.rates,
  backupRetentionDays: preferencesShape.backupRetentionDays,
  backupMaxCount: preferencesShape.backupMaxCount,
});

export function defaultModelPreferences(): ModelPreferences {
  return {
    version: 2,
    defaultMode: "chat",
    chat: { modelId: null, fallbackId: null },
    image: { modelId: null, fallbackId: null },
    video: { modelId: null, fallbackId: null },
    embeddingModelId: null,
    legacyCandidates: [],
    library: [],
    rates: {},
    backupRetentionDays: 30,
    backupMaxCount: 10,
  };
}

/** Converts pre-library settings into explicit migration candidates, never active models. */
export function upgradeModelPreferences(value: unknown, legacyEmbeddingModelId?: string): ModelPreferences {
  const current = preferencesSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacyPreferencesSchema.safeParse(value);
  if (!legacy.success) throw new Error("Unsupported model preference schema");
  const candidates = [
    ...modelModes.flatMap(mode => [legacy.data[mode].modelId, legacy.data[mode].fallbackId]
      .filter((modelId): modelId is string => Boolean(modelId))
      .map(modelId => ({ mode, modelId }))),
    ...(legacyEmbeddingModelId && openRouterModelIdSchema.safeParse(legacyEmbeddingModelId).success ? [{ mode: "embedding" as const, modelId: legacyEmbeddingModelId }] : []),
  ];
  const uniqueCandidates = [...new Map(candidates.map(candidate => [`${candidate.mode}:${candidate.modelId}`, candidate])).values()].slice(0, 20);
  return {
    ...defaultModelPreferences(),
    defaultMode: legacy.data.defaultMode,
    legacyCandidates: uniqueCandidates,
    rates: legacy.data.rates,
    backupRetentionDays: legacy.data.backupRetentionDays,
    backupMaxCount: legacy.data.backupMaxCount,
  };
}

export function libraryModel(preferences: ModelPreferences, mode: LibraryMode, modelId: string | null | undefined) {
  if (!modelId) return undefined;
  return preferences.library.find(item => item.providerId === "openrouter" && item.modelId === modelId && item.modes.includes(mode));
}
