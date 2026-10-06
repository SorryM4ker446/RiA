import { z } from "zod";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { libraryModes, modelIdSchema, providerIdSchema, type LibraryMode, type ProviderId } from "@/lib/models/preferences-schema";
import { CatalogFetchError, getModelProvider, listModelProviders, type CatalogFailureReason, type CatalogModel } from "@/lib/models/providers";

export type { CatalogModel } from "@/lib/models/providers";

/**
 * One mode of one provider, as the interface sees it: the rows, when they were
 * read, whether what is on screen is live or the last good copy, and why a
 * refresh failed. A failure never clears a previously good cache — the user can
 * still browse, and the reason is shown instead of being swallowed.
 */
export type CatalogState = {
  providerId: ProviderId;
  mode: LibraryMode;
  models: CatalogModel[];
  fetchedAt: string | null;
  stale: boolean;
  source: "live" | "cache" | "empty";
  error: string | null;
  /** Distinguishes "temporarily unreachable" from "the stored credential was rejected". */
  failure: CatalogFailureReason | null;
  skipped: number;
};

const failureReasons: CatalogFailureReason[] = ["http", "unauthorized", "timeout", "tooLarge", "empty", "notJson", "invalidShape", "emptyCatalog", "network"];
const catalogTimeoutMs = 12_000;
const cacheDurationMs = 24 * 60 * 60_000;
const failureCooldownMs = 30_000;
const inFlight = new Map<string, Promise<CatalogState>>();
const failures = new Map<string, { at: number; state: CatalogFailureReason; message: string }>();

const modeNames: Record<LibraryMode, string> = { chat: t("lib.models.catalogMode.chat"), image: t("lib.models.catalogMode.image"), video: t("lib.models.catalogMode.video"), embedding: t("lib.models.catalogMode.embedding") };

function cacheKey(providerId: ProviderId, mode: LibraryMode) {
  return `${providerId}:${mode}`;
}

const storedCatalogModel = z.object({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  name: z.string(),
  description: z.string(),
  modes: z.array(z.enum(libraryModes)),
  supportsImageInput: z.boolean(),
  endpointImageInput: z.boolean().nullable().optional(),
  supportsTools: z.boolean(),
  contextLength: z.number().int().positive().nullable(),
  pricing: z.record(z.string(), z.string()),
});

function describeFailure(reason: CatalogFailureReason, providerName: string, mode: LibraryMode, detail?: string): string {
  const subject = `${providerName} ${modeNames[mode]}`;
  switch (reason) {
    case "http": return `${subject}${t("lib.models.catalogHttpStatus")} ${detail ?? ""}`.trim();
    case "unauthorized": return `${subject}${t("lib.models.catalogUnauthorized")}`;
    case "timeout": return `${subject}${t("lib.models.catalogTimeoutSuffix")}`;
    case "tooLarge": return `${subject}${t("lib.models.catalogResponseTooLarge")}`;
    case "empty": return `${subject}${t("lib.models.catalogResponseEmpty")}`;
    case "notJson": return `${subject}${t("lib.models.catalogNotJson")}`;
    case "invalidShape": return `${subject}${t("lib.models.catalogInvalidShape")}`;
    case "emptyCatalog": return `${subject}${detail ? `${t("lib.models.catalogInvalidRowsPrefix")}${detail}${t("lib.models.catalogInvalidRowsSuffix")}` : t("lib.models.catalogEmptySuffix")}`;
    case "network": return `${subject}${t("lib.models.catalogReadFailed")}`;
  }
}

async function cachedSnapshot(providerId: ProviderId, mode: LibraryMode): Promise<{ models: CatalogModel[]; fetchedAt: Date; lastFailure: CatalogFailureReason | null } | null> {
  const snapshot = await db.modelCatalogSnapshot.findUnique({ where: { providerId_mode: { providerId, mode } } });
  if (!snapshot || !Array.isArray(snapshot.models)) return null;
  const models = snapshot.models.flatMap(value => {
    const parsed = storedCatalogModel.safeParse(value);
    return parsed.success && parsed.data.modes.includes(mode)
      ? [{ ...parsed.data, endpointImageInput: parsed.data.endpointImageInput ?? null } as CatalogModel]
      : [];
  });
  const lastFailure = typeof snapshot.lastFailure === "string" && failureReasons.includes(snapshot.lastFailure as CatalogFailureReason)
    ? snapshot.lastFailure as CatalogFailureReason
    : null;
  return { models, fetchedAt: snapshot.fetchedAt, lastFailure };
}

async function refresh(providerId: ProviderId, mode: LibraryMode): Promise<CatalogState> {
  const provider = getModelProvider(providerId);
  const key = cacheKey(providerId, mode);
  const old = await cachedSnapshot(providerId, mode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), catalogTimeoutMs);
  try {
    const { models, invalidRows } = await provider.fetchCatalog(mode, controller.signal);
    const fetchedAt = new Date();
    await db.modelCatalogSnapshot.upsert({
      where: { providerId_mode: { providerId, mode } },
      create: { providerId, mode, models: models as never, fetchedAt, lastFailure: null, lastFailureAt: null },
      update: { models: models as never, fetchedAt, lastFailure: null, lastFailureAt: null },
    });
    failures.delete(key);
    return { providerId, mode, models, fetchedAt: fetchedAt.toISOString(), stale: false, source: "live", error: null, failure: null, skipped: invalidRows };
  } catch (error) {
    const reason = error instanceof CatalogFetchError ? error.reason : "network";
    const message = describeFailure(reason, provider.displayName, mode, error instanceof CatalogFetchError ? error.detail : undefined);
    failures.set(key, { at: Date.now(), state: reason, message });
    // The snapshot keeps its rows and gains the reason. Without this the page
    // would forget a rejected credential the moment it reloaded and report the
    // models as merely unlisted.
    if (old) {
      await db.modelCatalogSnapshot.update({ where: { providerId_mode: { providerId, mode } }, data: { lastFailure: reason, lastFailureAt: new Date() } });
    }
    return {
      providerId, mode,
      models: old?.models ?? [],
      fetchedAt: old?.fetchedAt.toISOString() ?? null,
      stale: Boolean(old),
      source: old ? "cache" : "empty",
      error: message,
      failure: reason,
      skipped: 0,
    };
  } finally { clearTimeout(timer); }
}

/**
 * The snapshot on disk, without touching the network.
 *
 * Availability is computed on the settings page, and that page must not turn
 * into a proxy for a slow provider: a catalog that has never been read says
 * "not checked", not "delisted". Only the catalog endpoint fetches.
 */
export async function readCachedCatalog(providerId: ProviderId, mode: LibraryMode): Promise<CatalogState> {
  const snapshot = await cachedSnapshot(providerId, mode);
  const age = snapshot ? Date.now() - snapshot.fetchedAt.getTime() : 0;
  return {
    providerId, mode,
    models: snapshot?.models ?? [],
    fetchedAt: snapshot?.fetchedAt.toISOString() ?? null,
    // Stale here means "the snapshot is past its refresh window", not "a
    // refresh failed": this read made no attempt either way.
    stale: Boolean(snapshot) && age >= cacheDurationMs,
    source: snapshot ? "cache" : "empty",
    error: null,
    failure: snapshot?.lastFailure ?? null,
    skipped: 0,
  };
}

export async function readCachedCatalogs(): Promise<ProviderCatalogs> {
  const providers = listModelProviders();
  const result = await Promise.all(providers.map(async provider => {
    const states = await Promise.all(libraryModes.map(mode => readCachedCatalog(provider.id, mode)));
    return [provider.id, Object.fromEntries(states.map(state => [state.mode, state]))] as const;
  }));
  return Object.fromEntries(result) as ProviderCatalogs;
}

/**
 * A provider that does not offer a mode has no catalog for it, and asking
 * anyway would manufacture a failure the user cannot act on. Only the modes a
 * provider declares are requested; the rest stay absent.
 */
function offeredModes(providerId: ProviderId): LibraryMode[] {
  return libraryModes.filter(mode => getModelProvider(providerId).offeredModes.includes(mode));
}

export async function getCatalog(providerId: ProviderId, mode: LibraryMode, force = false): Promise<CatalogState> {
  // Refused here, where every caller passes through, rather than in each one.
  // Asking a provider for a mode it does not offer does not come back empty:
  // the fetch ignores the mode and answers with the provider's other models,
  // which would then be written to this mode's snapshot and shown to the user
  // as models that serve it. The mode is part of the request, so the request
  // has to be the one that is checkable.
  if (!getModelProvider(providerId).offeredModes.includes(mode)) {
    return { providerId, mode, models: [], fetchedAt: null, stale: false, source: "empty", error: null, failure: null, skipped: 0 };
  }
  const key = cacheKey(providerId, mode);
  const old = await cachedSnapshot(providerId, mode);
  if (!force && old && Date.now() - old.fetchedAt.getTime() < cacheDurationMs) {
    // The snapshot remembers how the last refresh went, and that is still the
    // truth about this provider: reporting a rejected key as a current,
    // error-free catalog hides a credential the user has to fix, for as long as
    // the cached models stay inside the window.
    const providerName = getModelProvider(providerId).displayName;
    return {
      providerId, mode, models: old.models, fetchedAt: old.fetchedAt.toISOString(), stale: old.lastFailure !== null,
      source: "cache",
      error: old.lastFailure ? describeFailure(old.lastFailure, providerName, mode) : null,
      failure: old.lastFailure,
      skipped: 0,
    };
  }
  const failure = failures.get(key);
  if (!force && failure && Date.now() - failure.at < failureCooldownMs) {
    return { providerId, mode, models: old?.models ?? [], fetchedAt: old?.fetchedAt.toISOString() ?? null, stale: Boolean(old), source: old ? "cache" : "empty", error: failure.message, failure: failure.state, skipped: 0 };
  }
  const existing = inFlight.get(key);
  if (existing) return existing;
  const operation = refresh(providerId, mode).finally(() => inFlight.delete(key));
  inFlight.set(key, operation);
  return operation;
}

export type ProviderCatalogs = Record<ProviderId, Record<LibraryMode, CatalogState>>;

export async function getCatalogs(force = false): Promise<ProviderCatalogs> {
  const providers = listModelProviders();
  const result = await Promise.all(providers.map(async provider => {
    const states = await Promise.all(offeredModes(provider.id).map(mode => getCatalog(provider.id, mode, force)));
    return [provider.id, Object.fromEntries(states.map(state => [state.mode, state]))] as const;
  }));
  return Object.fromEntries(result) as ProviderCatalogs;
}
