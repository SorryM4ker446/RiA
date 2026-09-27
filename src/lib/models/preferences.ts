import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";
import { getImageEndpointReferenceSupport } from "@/lib/models/catalog";
import {
  defaultModelPreferences,
  libraryModel,
  modelLibraryItemSchema,
  preferencesSchema,
  upgradeModelPreferences,
  type GenerationMode,
  type LibraryMode,
  type ModelLibraryItem,
  type ModelPreferences,
} from "@/lib/models/preferences-schema";

export const PREFERENCE_ROW_ID = "local";
const OPENROUTER_PROVIDER = "openrouter";

type PreferenceTx = PrismaClient | Prisma.TransactionClient;
type ModelSettingsLock = {
  tail: Promise<void>;
  activeLeases: Map<string, number>;
  leaseWaiters: Map<string, Set<() => void>>;
  removingModels: Set<string>;
};
const globalState = globalThis as typeof globalThis & { __privateAiModelSettingsLock?: Partial<ModelSettingsLock> };
const settingsLock = (globalState.__privateAiModelSettingsLock ??= { tail: Promise.resolve() }) as ModelSettingsLock;
settingsLock.activeLeases ??= new Map();
settingsLock.leaseWaiters ??= new Map();
settingsLock.removingModels ??= new Set();

export async function withModelSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = settingsLock.tail;
  let releaseNext!: () => void;
  settingsLock.tail = new Promise<void>(resolve => { releaseNext = resolve; });
  await previous;
  try { return await operation(); }
  finally { releaseNext(); }
}

function notifyLeaseWaiters(modelId: string) {
  if ((settingsLock.activeLeases.get(modelId) ?? 0) > 0) return;
  const waiters = settingsLock.leaseWaiters.get(modelId);
  settingsLock.leaseWaiters.delete(modelId);
  for (const resolve of waiters ?? []) resolve();
}

function incrementLease(modelId: string) {
  settingsLock.activeLeases.set(modelId, (settingsLock.activeLeases.get(modelId) ?? 0) + 1);
}

function decrementLease(modelId: string) {
  const next = (settingsLock.activeLeases.get(modelId) ?? 0) - 1;
  if (next > 0) settingsLock.activeLeases.set(modelId, next);
  else settingsLock.activeLeases.delete(modelId);
  notifyLeaseWaiters(modelId);
}

async function releaseModelLease(modelId: string) {
  await withModelSettingsLock(async () => { decrementLease(modelId); });
}

async function waitForModelLeases(modelId: string) {
  let waiter: Promise<void> | undefined;
  await withModelSettingsLock(async () => {
    if ((settingsLock.activeLeases.get(modelId) ?? 0) === 0) return;
    waiter = new Promise<void>(resolve => {
      const waiters = settingsLock.leaseWaiters.get(modelId) ?? new Set<() => void>();
      waiters.add(resolve);
      settingsLock.leaseWaiters.set(modelId, waiters);
    });
  });
  await waiter;
}

/**
 * Authorize a provider call at the same settings boundary as model mutations.
 * The provider operation is invoked before the settings lock is released, so
 * removal cannot slip between the membership check and provider submission.
 * The lease remains until that operation settles; model removal waits for the
 * active call, but it does not cancel or interrupt the provider request.
 */
export async function withModelLease<T>(mode: LibraryMode, modelId: string, operation: (model: ModelLibraryItem) => PromiseLike<T> | T): Promise<T> {
  let result!: Promise<T>;
  await withModelSettingsLock(async () => {
    if (settingsLock.removingModels.has(modelId)) {
      throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${modelId} ${t("lib.models.removingSuffix")}` });
    }
    const settings = await getModelPreferences();
    const model = libraryModel(settings, mode, modelId);
    if (!model) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${modelId} ${t("lib.models.notInLibrary")}${mode}${t("lib.models.notInLibraryHint")}` });
    incrementLease(modelId);
    try { result = Promise.resolve(operation(model)); }
    catch (error) {
      decrementLease(modelId);
      throw error;
    }
  });
  try { return await result; }
  finally { await releaseModelLease(modelId); }
}

async function persist(tx: PreferenceTx, settings: ModelPreferences) {
  await tx.workspacePreference.upsert({
    where: { id: PREFERENCE_ROW_ID },
    create: { id: PREFERENCE_ROW_ID, settings: settings as Prisma.InputJsonValue },
    update: { settings: settings as Prisma.InputJsonValue },
  });
}

async function readPreferences(tx: PreferenceTx): Promise<ModelPreferences> {
  const record = await tx.workspacePreference.findUnique({ where: { id: PREFERENCE_ROW_ID } });
  if (!record) return defaultModelPreferences();
  const parsed = preferencesSchema.safeParse(record.settings);
  if (parsed.success) return parsed.data;
  if ((record.settings as { version?: unknown } | null)?.version !== 1) {
    throw new ApiError({ code: "CONFIGURATION_ERROR", message: t("lib.models.invalidSettings") });
  }
  let upgraded: ModelPreferences;
  try { upgraded = upgradeModelPreferences(record.settings, process.env.EMBEDDING_MODEL_ID?.trim()); }
  catch { throw new ApiError({ code: "CONFIGURATION_ERROR", message: t("lib.models.invalidSettings") }); }
  await persist(tx, upgraded);
  return upgraded;
}

export async function getModelPreferences(): Promise<ModelPreferences> { return readPreferences(db); }

export async function saveModelPreferences(value: unknown) {
  const parsed = preferencesSchema.parse(value);
  return withModelSettingsLock(() => db.$transaction(async tx => {
    const current = await readPreferences(tx);
    const library = current.library;
    const legacyCandidates = current.legacyCandidates.filter(candidate => !libraryModel(current, candidate.mode, candidate.modelId));
    const settings = preferencesSchema.parse({ ...parsed, library, legacyCandidates });
    await persist(tx, settings);
    return settings;
  }));
}

export async function preferredModel(mode: GenerationMode, supplied?: string | null) {
  const settings = await getModelPreferences();
  const modelId = supplied ?? settings[mode].modelId;
  if (!modelId) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.addFirstPrefix")}${mode === "chat" ? t("lib.models.modeChat") : mode === "image" ? t("lib.models.modeImage") : t("lib.models.modeVideo")}${t("lib.models.addFirstSuffix")}` });
  if (!libraryModel(settings, mode, modelId)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${modelId} ${t("lib.models.notInLibrary")}${mode}${t("lib.models.notInLibraryHint")}` });
  return modelId;
}

export async function modelInLibrary(mode: LibraryMode, modelId: string | null | undefined) {
  if (!modelId) return null;
  const settings = await getModelPreferences();
  return libraryModel(settings, mode, modelId) ?? null;
}

export async function addOpenRouterModel(modelId: string): Promise<{ data: ModelLibraryItem; alreadyAdded: boolean }> {
  const snapshots = await db.modelCatalogSnapshot.findMany({ where: { providerId: OPENROUTER_PROVIDER } });
  const matches = snapshots.flatMap(snapshot => {
    const rows = Array.isArray(snapshot.models) ? snapshot.models : [];
    return rows.flatMap(row => {
      const item = modelLibraryItemSchema.pick({ providerId: true, modelId: true, name: true, description: true, modes: true, supportsImageInput: true, endpointImageInput: true, supportsTools: true, contextLength: true, pricing: true, addedAt: true, lastSeenAt: true }).safeParse({
        ...(row as Record<string, unknown>), addedAt: new Date().toISOString(), lastSeenAt: snapshot.fetchedAt.toISOString(),
      });
      return item.success && item.data.modelId === modelId ? [{ item: item.data, fetchedAt: snapshot.fetchedAt }] : [];
    });
  });
  if (!matches.length) throw new ApiError({ code: "NOT_FOUND", message: t("lib.models.notInCatalog") });
  const modes = [...new Set(matches.flatMap(match => match.item.modes))] as LibraryMode[];
  const hasImageGeneration = modes.includes("image");
  const endpointImageInput = hasImageGeneration ? await getImageEndpointReferenceSupport(modelId) : null;

  return withModelSettingsLock(() => db.$transaction(async tx => {
    const current = await readPreferences(tx);
    const existing = current.library.find(item => item.providerId === OPENROUTER_PROVIDER && item.modelId === modelId);
    const latest = [...matches].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0].item;
    const next = modelLibraryItemSchema.parse({
      ...latest,
      modes,
      supportsImageInput: matches.some(match => match.item.modes.includes("chat") && match.item.supportsImageInput) || endpointImageInput === true || (!hasImageGeneration && matches.some(match => match.item.supportsImageInput)),
      endpointImageInput,
      supportsTools: matches.some(match => match.item.supportsTools),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      lastSeenAt: matches.reduce((date, match) => match.fetchedAt > date ? match.fetchedAt : date, matches[0].fetchedAt).toISOString(),
    });
    const settings = preferencesSchema.parse({ ...current, library: [...current.library.filter(item => item.modelId !== modelId), next], legacyCandidates: current.legacyCandidates.filter(candidate => candidate.modelId !== modelId) });
    await persist(tx, settings);
    return { data: next, alreadyAdded: Boolean(existing) };
  }));
}

export async function removeOpenRouterModel(modelId: string) {
  await withModelSettingsLock(async () => {
    if (settingsLock.removingModels.has(modelId)) {
      throw new ApiError({ code: "CONFLICT", message: t("lib.models.removeConflict") });
    }
    const current = await readPreferences(db);
    const exists = current.library.some(item => item.providerId === OPENROUTER_PROVIDER && item.modelId === modelId);
    if (!exists) throw new ApiError({ code: "NOT_FOUND", message: t("lib.models.notAdded") });
    settingsLock.removingModels.add(modelId);
  });
  try {
    await waitForModelLeases(modelId);
    return await withModelSettingsLock(() => db.$transaction(async tx => {
      const current = await readPreferences(tx);
      const exists = current.library.some(item => item.providerId === OPENROUTER_PROVIDER && item.modelId === modelId);
      if (!exists) throw new ApiError({ code: "NOT_FOUND", message: t("lib.models.notAdded") });
      const settings = preferencesSchema.parse({
        ...current,
        library: current.library.filter(item => !(item.providerId === OPENROUTER_PROVIDER && item.modelId === modelId)),
        chat: { modelId: current.chat.modelId === modelId ? null : current.chat.modelId, fallbackId: current.chat.fallbackId === modelId ? null : current.chat.fallbackId },
        image: { modelId: current.image.modelId === modelId ? null : current.image.modelId, fallbackId: current.image.fallbackId === modelId ? null : current.image.fallbackId },
        video: { modelId: current.video.modelId === modelId ? null : current.video.modelId, fallbackId: current.video.fallbackId === modelId ? null : current.video.fallbackId },
        embeddingModelId: current.embeddingModelId === modelId ? null : current.embeddingModelId,
      });
      await persist(tx, settings);
      return settings;
    }));
  }
  finally {
    await withModelSettingsLock(async () => { settingsLock.removingModels.delete(modelId); });
  }
}

export async function selectFallback(mode: GenerationMode, id: string | null) {
  return withModelSettingsLock(() => db.$transaction(async tx => {
    const current = await readPreferences(tx);
    const settings = preferencesSchema.parse({ ...current, [mode]: { ...current[mode], fallbackId: id } });
    await persist(tx, settings);
    return settings;
  }));
}
