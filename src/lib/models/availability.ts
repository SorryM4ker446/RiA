import type { CatalogState } from "@/lib/models/catalog";
import type { CatalogFailureReason } from "@/lib/models/providers";
import { getModelProvider, listModelProviders } from "@/lib/models/providers";
import { modelRefKey, type ModelLibraryItem, type ModelPreferences } from "@/lib/models/preferences-schema";

/**
 * Why a library entry can or cannot be used right now.
 *
 * These are display states, not routing decisions. A model that has been
 * delisted keeps its library entry, its media recipes and its history; the
 * interface says what happened and the user decides. Nothing here substitutes
 * another model, because a silent swap spends money on a different one.
 */
export type ModelAvailability = {
  state: "ready" | "unconfigured" | "catalogUnavailable" | "notChecked" | "notInCatalog";
  reason: CatalogFailureReason | null;
};

export type LibraryAvailability = Record<string, ModelAvailability>;

function listedSomewhere(item: ModelLibraryItem, catalogs: Record<string, Record<string, CatalogState>>) {
  const providerCatalogs = catalogs[item.providerId];
  if (!providerCatalogs) return false;
  return item.modes.some(mode => providerCatalogs[mode]?.models.some(row => row.modelId === item.modelId));
}

function readFailure(catalogs: Record<string, Record<string, CatalogState>>, item: ModelLibraryItem) {
  const providerCatalogs = catalogs[item.providerId] ?? {};
  let reason: CatalogFailureReason | null = null;
  let unread = false;
  for (const mode of item.modes) {
    const state = providerCatalogs[mode];
    if (!state) { unread = true; continue; }
    // A remembered failure is reported even when its rows are being shown from
    // cache: the catalog may well still list the model, and saying "no longer
    // offered" on the strength of a failed read would be the opposite of true.
    if (state.failure) { reason ??= state.failure; if (state.source !== "cache") unread = true; continue; }
    // No successful read for this category means the model is simply unknown,
    // which is a different claim from "the provider stopped offering it".
    if (!state.fetchedAt) unread = true;
  }
  return { reason, unread };
}

/**
 * Annotates the library with what the catalogs currently say about it.
 *
 * The order matters: a provider whose credential was rejected, or whose catalog
 * could not be read at all, is reported as unreachable rather than as having
 * delisted every model — the absence is a fact about the read, not about the
 * model. Only a catalog that was read successfully and no longer lists the
 * model reports it as gone.
 */
export function resolveLibraryAvailability(
  preferences: ModelPreferences,
  catalogs: Record<string, Record<string, CatalogState>>,
): LibraryAvailability {
  const availability: LibraryAvailability = {};
  for (const item of preferences.library) {
    const key = modelRefKey(item);
    if (!getModelProvider(item.providerId).isConfigured()) {
      availability[key] = { state: "unconfigured", reason: null };
      continue;
    }
    const { reason, unread } = readFailure(catalogs, item);
    if (reason) {
      availability[key] = { state: "catalogUnavailable", reason };
      continue;
    }
    if (unread) {
      availability[key] = { state: "notChecked", reason: null };
      continue;
    }
    availability[key] = listedSomewhere(item, catalogs)
      ? { state: "ready", reason: null }
      : { state: "notInCatalog", reason: null };
  }
  return availability;
}

/**
 * Whether this instance holds each provider's credentials. The page reads it
 * before any call so a missing key is a sentence in the interface rather than a
 * failed request.
 */
export function describeProviders() {
  return listModelProviders().map(provider => ({
    providerId: provider.id,
    displayName: provider.displayName,
    configured: provider.isConfigured(),
  }));
}
