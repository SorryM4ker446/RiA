import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";
import { getModelProvider } from "@/lib/models/providers";
import {
  defaultModelPreferences,
  libraryModel,
  modelLibraryItemSchema,
  modelRefKey,
  preferencesSchema,
  upgradeModelPreferences,
  type GenerationMode,
  type LibraryMode,
  type ModelLibraryItem,
  type ModelPreferences,
  type ModelRef,
} from "@/lib/models/preferences-schema";

export const PREFERENCE_ROW_ID = "local";

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

function notifyLeaseWaiters(key: string) {
  if ((settingsLock.activeLeases.get(key) ?? 0) > 0) return;
  const waiters = settingsLock.leaseWaiters.get(key);
  settingsLock.leaseWaiters.delete(key);
  for (const resolve of waiters ?? []) resolve();
}

function incrementLease(key: string) {
  settingsLock.activeLeases.set(key, (settingsLock.activeLeases.get(key) ?? 0) + 1);
}

function decrementLease(key: string) {
  const next = (settingsLock.activeLeases.get(key) ?? 0) - 1;
  if (next > 0) settingsLock.activeLeases.set(key, next);
  else settingsLock.activeLeases.delete(key);
  notifyLeaseWaiters(key);
}

async function releaseModelLease(key: string) {
  await withModelSettingsLock(async () => { decrementLease(key); });
}

async function waitForModelLeases(key: string) {
  let waiter: Promise<void> | undefined;
  await withModelSettingsLock(async () => {
    if ((settingsLock.activeLeases.get(key) ?? 0) === 0) return;
    waiter = new Promise<void>(resolve => {
      const waiters = settingsLock.leaseWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      settingsLock.leaseWaiters.set(key, waiters);
    });
  });
  await waiter;
}

/**
 * Authorize a provider call at the same settings boundary as model mutations.
 * The lease is acquired under the same lock as removal. A removal that starts
 * after acquisition waits for its release before changing membership.
 * The lease remains until that operation settles; model removal waits for the
 * active call, but it does not cancel or interrupt the provider request.
 *
 * The lease is keyed by provider and model together, so removing one provider's
 * entry never waits on — or is blocked by — an unrelated model with the same id.
 */
export async function withModelLease<T>(mode: LibraryMode, ref: ModelRef, operation: (model: ModelLibraryItem) => PromiseLike<T> | T): Promise<T> {
  const lease = await acquireModelLease(mode, ref);
  try { return await operation(lease.model); }
  finally { await lease.release(); }
}

/** The consumer owns this lease until its provider stream terminates. */
export async function acquireModelLease(mode: LibraryMode, ref: ModelRef) {
  const key = modelRefKey(ref);
  const model = await withModelSettingsLock(async () => {
    if (settingsLock.removingModels.has(key)) {
      throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${ref.modelId} ${t("lib.models.removingSuffix")}` });
    }
    const settings = await getModelPreferences();
    const model = libraryModel(settings, mode, ref);
    if (!model) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${ref.modelId} ${t("lib.models.notInLibrary")}${mode}${t("lib.models.notInLibraryHint")}` });
    incrementLease(key);
    return model;
  });
  let release: Promise<void> | undefined;
  return { model, release: () => release ??= releaseModelLease(key) };
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
  if (![1, 2].includes((record.settings as { version?: unknown } | null)?.version as 1 | 2)) {
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
    const legacyCandidates = current.legacyCandidates.filter(candidate => !libraryModel(current, candidate.mode, candidate.ref));
    const settings = preferencesSchema.parse({ ...parsed, library, legacyCandidates });
    await persist(tx, settings);
    return settings;
  }));
}

export async function preferredModel(mode: GenerationMode, supplied?: ModelRef | null): Promise<ModelRef> {
  const settings = await getModelPreferences();
  const ref = supplied ?? settings[mode].model;
  if (!ref) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.addFirstPrefix")}${mode === "chat" ? t("lib.models.modeChat") : mode === "image" ? t("lib.models.modeImage") : t("lib.models.modeVideo")}${t("lib.models.addFirstSuffix")}` });
  if (!libraryModel(settings, mode, ref)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${ref.modelId} ${t("lib.models.notInLibrary")}${mode}${t("lib.models.notInLibraryHint")}` });
  return ref;
}

export async function modelInLibrary(mode: LibraryMode, ref: ModelRef | null | undefined) {
  if (!ref) return null;
  const settings = await getModelPreferences();
  return libraryModel(settings, mode, ref) ?? null;
}

export async function addModel(ref: ModelRef): Promise<{ data: ModelLibraryItem; alreadyAdded: boolean }> {
  const key = modelRefKey(ref);
  const provider = getModelProvider(ref.providerId);
  const snapshots = await db.modelCatalogSnapshot.findMany({ where: { providerId: ref.providerId } });
  // A catalog row is provider data and may carry fields this application does
  // not store. The library entry is built from an explicit list of them, so a
  // new provider field cannot make a model silently un-addable.
  const libraryFields = { providerId: true, modelId: true, name: true, description: true, modes: true, supportsImageInput: true, endpointImageInput: true, supportsTools: true, providerSearch: true, contextLength: true, pricing: true, addedAt: true, lastSeenAt: true } as const;
  const matches = snapshots.flatMap(snapshot => {
    const rows = Array.isArray(snapshot.models) ? snapshot.models : [];
    return rows.flatMap(row => {
      const source = row as Record<string, unknown>;
      // The two timestamps describe when the entry was added and when the
      // catalog that describes it was read, not anything the row carries.
      const item = modelLibraryItemSchema.pick(libraryFields).safeParse({
        ...Object.fromEntries(Object.keys(libraryFields).filter(field => field !== "addedAt" && field !== "lastSeenAt").map(field => [field, source[field]])),
        addedAt: new Date().toISOString(),
        lastSeenAt: snapshot.fetchedAt.toISOString(),
      });
      return item.success && item.data.modelId === ref.modelId ? [{ item: item.data, fetchedAt: snapshot.fetchedAt }] : [];
    });
  });
  if (!matches.length) throw new ApiError({ code: "NOT_FOUND", message: t("lib.models.notInCatalog") });
  const modes = [...new Set(matches.flatMap(match => match.item.modes))] as LibraryMode[];
  const hasImageGeneration = modes.includes("image");
  const probe = provider.probeImageInput;
  const endpointImageInput = hasImageGeneration && probe ? await probe(ref.modelId) : null;

  return withModelSettingsLock(() => db.$transaction(async tx => {
    const current = await readPreferences(tx);
    const existing = current.library.find(item => modelRefKey(item) === key);
    const latest = [...matches].sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0].item;
    const next = modelLibraryItemSchema.parse({
      ...latest,
      modes,
      supportsImageInput: matches.some(match => match.item.modes.includes("chat") && match.item.supportsImageInput) || endpointImageInput === true || (!hasImageGeneration && matches.some(match => match.item.supportsImageInput)),
      endpointImageInput,
      supportsTools: matches.some(match => match.item.supportsTools),
      // Refreshed on every add, so a model the provider changed into an
      // online variant is noticed the next time it is added or re-added.
      providerSearch: matches.some(match => match.item.providerSearch),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      lastSeenAt: matches.reduce((date, match) => match.fetchedAt > date ? match.fetchedAt : date, matches[0].fetchedAt).toISOString(),
    });
    const settings = preferencesSchema.parse({
      ...current,
      library: [...current.library.filter(item => modelRefKey(item) !== key), next],
      legacyCandidates: current.legacyCandidates.filter(candidate => modelRefKey(candidate.ref) !== key),
    });
    await persist(tx, settings);
    return { data: next, alreadyAdded: Boolean(existing) };
  }));
}

export async function removeModel(ref: ModelRef) {
  const key = modelRefKey(ref);
  await withModelSettingsLock(async () => {
    if (settingsLock.removingModels.has(key)) {
      throw new ApiError({ code: "CONFLICT", message: t("lib.models.removeConflict") });
    }
    const current = await readPreferences(db);
    const exists = current.library.some(item => modelRefKey(item) === key);
    if (!exists) throw new ApiError({ code: "NOT_FOUND", message: t("lib.models.notAdded") });
    settingsLock.removingModels.add(key);
  });
  try {
    await waitForModelLeases(key);
    return await withModelSettingsLock(() => db.$transaction(async tx => {
      const current = await readPreferences(tx);
      const exists = current.library.some(item => modelRefKey(item) === key);
      if (!exists) throw new ApiError({ code: "NOT_FOUND", message: t("lib.models.notAdded") });
      const clear = (value: ModelRef | null) => (value && modelRefKey(value) === key ? null : value);
      const settings = preferencesSchema.parse({
        ...current,
        library: current.library.filter(item => modelRefKey(item) !== key),
        chat: { model: clear(current.chat.model), fallback: clear(current.chat.fallback) },
        image: { model: clear(current.image.model), fallback: clear(current.image.fallback) },
        video: { model: clear(current.video.model), fallback: clear(current.video.fallback) },
        embedding: clear(current.embedding),
      });
      await persist(tx, settings);
      return settings;
    }));
  }
  finally {
    await withModelSettingsLock(async () => { settingsLock.removingModels.delete(key); });
  }
}
