"use client";
import { useLocale } from "@/lib/locale/client";

import { formatDateTime, t, tf, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";
import Link from "next/link";
import { BackToChatLink } from "@/components/layout/back-to-chat-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CatalogResults } from "@/features/models/catalog-results";
import { ContextSettings } from "@/features/models/context-settings";
import { UsageHistory, sourceNames, type UsageRow } from "@/features/models/usage-history";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsRequest, jsonRequest } from "@/features/settings/api-client";
import { libraryModes, modelModes, modelRefKey, type ModelLibraryItem, type ModelPreferences, type ModelRef, type GenerationMode, type LibraryMode } from "@/lib/models/preferences-schema";
import type { LibraryAvailability, ModelAvailability } from "@/lib/models/availability";
import type { CatalogModel } from "@/lib/models/providers/types";
type Usage = { controls?: ModelPreferences["callLimits"] & { day: string; calls: number; estimatedUsd: number; active: number }; recent: UsageRow[]; totals: { requests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; unknownCostRequests: number } };
type CatalogState = { models: CatalogModel[]; fetchedAt: string | null; stale: boolean; source: "live" | "cache" | "empty"; error: string | null; failure: string | null; skipped: number };
type ProviderSummary = { providerId: string; displayName: string; configured: boolean };
type EmbeddingSummary = { total: number; stale: number; embedding: string | null };
const modeNames = (): Record<LibraryMode, string> => ({ chat: t("models.mode.chat"), image: t("models.mode.image"), video: t("models.mode.video"), embedding: t("models.mode.embedding") });
const cost = (value: number | null) => value === null ? t("models.unknown") : `$${value.toFixed(6)}`;
// Radix reserves the empty string for "no selection" and throws if an item
// declares it, so "not configured" needs a value that cannot collide with a
// real selection. Selections carry a provider prefix, so this cannot collide
// with one either.
const UNSET = "__unset__";
const toSelectValue = (ref: ModelRef | null) => (ref ? modelRefKey(ref) : UNSET);
const fromSelectValue = (value: string): ModelRef | null => {
  if (value === UNSET) return null;
  const [providerId, ...rest] = value.split(":");
  return rest.length ? { providerId: providerId as ModelRef["providerId"], modelId: rest.join(":") } : null;
};

export default function ModelsPage() {
  useLocale();
  const [settings, setSettings] = useState<ModelPreferences | null>(null), [usage, setUsage] = useState<Usage | null>(null);
  const [usageSource, setUsageSource] = useState("all");
  const [usageError, setUsageError] = useState("");
  const changeUsageSource = (value: string) => { if (value !== usageSource) { setUsage(null); setUsageError(""); setUsageSource(value); } };
  const [catalogMode, setCatalogMode] = useState<LibraryMode>("chat");
  // The catalog is browsed one provider at a time. Two entries with the same
  // model id are different models, so mixing them into one list would hide
  // which one the add button would add.
  const [catalogProvider, setCatalogProvider] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, Partial<Record<LibraryMode, CatalogState>>>>({});
  const [query, setQuery] = useState("");
  const [availability, setAvailability] = useState<LibraryAvailability>({});
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [embeddings, setEmbeddings] = useState<EmbeddingSummary | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const preferences = await settingsRequest<{ data: ModelPreferences; availability: LibraryAvailability; providers: ProviderSummary[]; recentFailures: { modelId: string }[] }>("/api/models");
    setSettings(current => current ? { ...current, ...preferences.data } : preferences.data);
    setAvailability(preferences.availability ?? {});
    setProviders(preferences.providers ?? []);
    setWarnings([...new Set(preferences.recentFailures.map(item => tf("models.warningForModel", { modelId: item.modelId, reason: t("models.missingModelWarning") })))]);
    // The embedding summary is an aside on this page. A failure reading it must
    // not take the library, the catalog and the preferences down with it, so it
    // settles on its own and only reports itself.
    settingsRequest<{ data: EmbeddingSummary }>("/api/memory/reindex")
      .then(response => setEmbeddings(response.data))
      .catch(() => setEmbeddings(null));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    settingsRequest<{ data: Usage }>(usageSource === "all" ? "/api/usage" : `/api/usage?source=${usageSource}`, { signal: controller.signal })
      .then(history => { if (!controller.signal.aborted) { setUsage(history.data); setUsageError(""); } })
      .catch(cause => { if (!controller.signal.aborted) setUsageError(cause instanceof Error ? cause.message : t("ui.models.couldNotLoadUsage")); });
    return () => controller.abort();
  }, [usageSource]);
  const loadCatalog = useCallback(async (providerId: string, mode: LibraryMode, force = false) => {
    const query2 = force ? "" : `?providerId=${encodeURIComponent(providerId)}&mode=${mode}`;
    const response = await settingsRequest<{ catalogs: Record<string, Partial<Record<LibraryMode, CatalogState>>> }>(`/api/models/catalog${query2}`, force ? jsonRequest("POST", { providerId, mode }) : undefined);
    setCatalogs(current => ({ ...current, [providerId]: { ...current[providerId], ...(response.catalogs[providerId] ?? {}) } }));
  }, []);
  const activeProvider = catalogProvider ?? providers[0]?.providerId ?? null;
  const activeCatalog = activeProvider ? catalogs[activeProvider]?.[catalogMode] : undefined;
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : t("models.error.load"))); }, [load]);
  // The provider list arrives with the preferences, so the first provider is
  // only known after that load; until then there is nothing to fetch.
  useEffect(() => {
    if (!activeProvider || activeCatalog) return;
    void loadCatalog(activeProvider, catalogMode).catch(cause => setError(cause instanceof Error ? cause.message : t("models.error.loadCatalog")));
  }, [activeProvider, activeCatalog, catalogMode, loadCatalog]);
  async function addFromCatalog(item: CatalogModel) {
    const key = modelRefKey(item);
    const result = await settingsRequest<{ data: ModelLibraryItem; alreadyAdded: boolean }>("/api/models/library", jsonRequest("POST", { action: "add", model: { providerId: item.providerId, modelId: item.modelId } }));
    setSettings(current => current ? { ...current, library: [...current.library.filter(model => modelRefKey(model) !== key), result.data], legacyCandidates: current.legacyCandidates.filter(candidate => modelRefKey(candidate.ref) !== key) } : current);
    setNotice(result.alreadyAdded ? t("models.notice.capabilityUpdated") : tf("models.notice.addedBefore", { modelId: item.modelId }));
  }
  async function run(operation: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("models.error.act")); } finally { setBusy(false); } }
  function changeMode(mode: GenerationMode, field: "model" | "fallback", value: ModelRef | null) { if (settings) setSettings({ ...settings, [mode]: { ...settings[mode], [field]: value } }); }
  function changeRate(id: string, key: "inputPerMillion" | "outputPerMillion" | "perRequest" | "cacheReadPerMillion" | "cacheWritePerMillion", value: string) { if (settings) setSettings({ ...settings, rates: { ...settings.rates, [id]: { ...(settings.rates[id] ?? { inputPerMillion: null, outputPerMillion: null, perRequest: null }), [key]: value === "" ? null : Number(value) } } }); }
  // Rates are keyed by provider and model, so the two entries for the same
  // underlying model reached through different providers are edited separately.
  const rateModels = useMemo(() => {
    if (!settings) return [];
    const refs: ModelRef[] = [...modelModes.flatMap(mode => [settings[mode].model, settings[mode].fallback]).filter((ref): ref is ModelRef => Boolean(ref))];
    if (settings.embedding) refs.push(settings.embedding);
    return [...new Set(refs.map(ref => modelRefKey(ref)))];
  }, [settings]);
  const filteredModels = useMemo(() => (activeCatalog?.models ?? []).filter(item => `${item.modelId} ${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())), [activeCatalog, query]);
  const added = useMemo(() => new Set(settings?.library.map(item => modelRefKey(item)) ?? []), [settings]);
  function updateSettings(next: ModelPreferences) { setSettings(next); }
  const providerName = (providerId: string) => providers.find(provider => provider.providerId === providerId)?.displayName ?? providerId;
  // Written out rather than interpolated: the locale table is typed by key, and
  // a computed string would quietly fall out of that check.
  const availabilityLabels: Record<ModelAvailability["state"], () => string> = {
    ready: () => t("models.availability.ready"),
    notChecked: () => t("models.availability.notChecked"),
    unconfigured: () => t("models.availability.unconfigured"),
    catalogUnavailable: () => t("models.availability.catalogUnavailable"),
    notInCatalog: () => t("models.availability.notInCatalog"),
  };
  const availabilityLabel = (state: ModelAvailability["state"] | undefined) => availabilityLabels[state ?? "ready"]();
  const availabilityBadgeClass = (state: ModelAvailability["state"] | undefined) => state && state !== "ready"
    ? "rounded-full bg-warning/15 px-2 py-0.5 text-warning"
    : "rounded-full bg-muted px-2 py-0.5";
  /**
   * Rebuilding is paid work, so it asks first. The dialog is the browser's
   * because the page has no form to submit and the answer is a yes/no, not
   * something to type.
   */
  async function rebuildEmbeddings() {
    if (!window.confirm(t("models.embeddingReindexConfirm"))) return;
    const response = await settingsRequest<{ data: { reindexed: number; remaining: number } }>("/api/memory/reindex", jsonRequest("POST", { confirm: true }));
    setNotice(tf("models.notice.embeddingReindexed", { reindexed: response.data.reindexed, remaining: response.data.remaining }));
    setEmbeddings(current => current ? { ...current, stale: response.data.remaining } : current);
  }
  return <main className="mx-auto flex max-w-6xl flex-col gap-7">
    <header className="workspace-page-header"><div><h1>{t("models.title")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("models.description")}</p></div><BackToChatLink /></header>
    <nav className="models-section-nav" aria-label={t("ui.models.modelPageSections")}>
      <a href="#model-library">{t("models.libraryTitle")}</a><a href="#model-catalog">{t("ui.models.officialCatalog")}</a><a href="#model-preferences">{t("ui.models.defaultsCallSettings")}</a><a href="#model-usage">{t("ui.models.usageHistory")}</a>
    </nav>
    <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("models.sourceNote")}</p>
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{localizeMessage(notice)}</p>}{warnings.map(warning => <p role="alert" key={warning} className="break-words rounded-lg bg-warning/5 p-3 text-sm text-warning shadow-hairline">{warning}</p>)}
    {settings && <>
      <section id="model-library" className="models-section flex flex-col gap-4 rounded-xl bg-card p-6 shadow-card" aria-label={t("models.libraryLabel")}><div className="flex flex-col gap-2"><h2 className="text-lg font-semibold tracking-title">{t("models.libraryTitle")}</h2></div>
        {settings.library.length ? <ul className="flex flex-col gap-2">{settings.library.map(item => <li key={`${item.providerId}:${item.modelId}`} className="catalog-library-row min-w-0 rounded-lg p-3 transition-colors hover:bg-muted/50"><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="break-all font-medium tracking-label">{item.name}</h3><p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="break-all font-mono">{item.modelId}</span><span>{providerName(item.providerId)}</span></p><div className="mt-2 flex flex-wrap gap-1 text-xs">{item.modes.map(mode => <span className="rounded-full bg-muted px-2 py-0.5" key={mode}>{modeNames()[mode]}</span>)}{item.supportsImageInput && <span className="rounded-full bg-muted px-2 py-0.5">{t("models.badge.imageInput")}</span>}{item.modes.includes("image") && <span className="rounded-full bg-muted px-2 py-0.5">{tf("models.badge.imageEndpoint", { status: item.endpointImageInput === null ? t("models.badge.endpointUnverified") : item.endpointImageInput ? t("models.badge.endpointCompatible") : t("models.badge.endpointIncompatible") })}</span>}{item.supportsTools && <span className="rounded-full bg-muted px-2 py-0.5">{t("models.badge.tools")}</span>}<span className={availabilityBadgeClass(availability[modelRefKey(item)]?.state)}>{availabilityLabel(availability[modelRefKey(item)]?.state)}</span>{item.providerSearch && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{t("models.badge.providerSearch")}</span>}</div></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { const result = await settingsRequest<{ data: ModelPreferences }>("/api/models/library", jsonRequest("POST", { action: "remove", model: { providerId: item.providerId, modelId: item.modelId } })); updateSettings(result.data); setNotice(tf("models.removedFromLibrary", { modelId: item.modelId })); })}>{t("models.remove")}</Button></div></li>)}</ul> : <p className="empty-state !p-4 !text-left">{t("models.libraryEmpty")}</p>}
      </section>
      <section id="model-catalog" className="models-section flex flex-col gap-5 rounded-xl bg-card p-6 shadow-card" aria-label={t("models.catalogLabel")}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-col gap-2"><h2 className="text-lg font-semibold tracking-title">{t("models.catalogTitle")}</h2><p className="text-sm leading-6 text-muted-foreground">{t("models.catalogDescription")}</p></div><RefreshButton disabled={busy} onClick={() => void run(async () => { if (activeProvider) await loadCatalog(activeProvider, catalogMode, true); setNotice(t("models.notice.catalogRefreshed")); })} label={t("models.refreshCatalog")} /></div>
        <label className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">{t("ui.models.modelServices")}<SelectField aria-label={t("models.providerTabsLabel")} value={activeProvider ?? ""} onValueChange={value => { setQuery(""); setCatalogProvider(value); }}>
            {providers.map(provider => <SelectOption key={provider.providerId} value={provider.providerId}>{provider.displayName}</SelectOption>)}
          </SelectField>
        </label>
        <Tabs value={catalogMode} onValueChange={value => { setQuery(""); setCatalogMode(value as LibraryMode); }} className="flex flex-col gap-5">
        <TabsList aria-label={t("models.modeTabsLabel")}>{libraryModes.map(mode => <TabsTrigger key={mode} value={mode}>{modeNames()[mode]}</TabsTrigger>)}</TabsList>
        {libraryModes.map(mode => <TabsContent key={mode} value={mode} className="flex flex-col gap-4">{mode === catalogMode ? <>
        {/* A provider with no key cannot return a catalog, and saying so beats
            an empty list that looks like the provider offers nothing. */}
        {activeProvider && !providers.find(provider => provider.providerId === activeProvider)?.configured && <p className="text-sm text-warning">{tf("models.providerKeyMissing", { provider: providerName(activeProvider) })}</p>}
        <Input aria-label={t("models.searchLabel")} placeholder={t("models.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
        {activeCatalog?.error && <p role="status" className="text-sm text-warning">{activeCatalog.stale ? t("models.notice.catalogStale") : t("models.notice.catalogUnavailable")} {activeCatalog.error}</p>}
        {/* A partial parse is a note, not a failure: the rows that did validate
            are listed below. */}
        {/* A plain note, not a live region: `role="status"` here would collide
            with the page's save confirmation, and nothing about a skipped row
            is announced — it is already visible in the list below. */}
        {!activeCatalog?.error && (activeCatalog?.skipped ?? 0) > 0 && <p className="text-xs text-muted-foreground">{tf("models.notice.catalogSkipped", { count: activeCatalog!.skipped })}</p>}
        <p className="text-xs text-muted-foreground">{`${activeCatalog?.models.length ?? 0} ${t("models.catalog.countUnit")}${activeCatalog?.fetchedAt ? ` ${t("models.divider")} ${t("models.catalog.updatedAt")} ${formatDateTime(activeCatalog.fetchedAt)}` : ""}${activeCatalog?.stale ? ` ${t("models.divider")} ${t("models.catalog.cachedData")}` : ""} ${t("models.divider")} ${t("models.catalog.limit")}`}</p>
        <CatalogResults key={`${activeProvider}:${catalogMode}:${query}:${activeCatalog?.fetchedAt}`} models={filteredModels} added={added} busy={busy} onAdd={item => void run(() => addFromCatalog(item))} />
        </> : null}</TabsContent>)}
        </Tabs>
      </section>
      <section id="model-preferences" className="models-section flex flex-col gap-5 rounded-xl bg-card p-6 shadow-card" aria-label={t("models.preferencesLabel")}>
        <div className="flex flex-col gap-2"><h2 className="text-lg font-semibold tracking-title">{t("ui.models.defaultsCallSettings")}</h2><p className="text-sm text-muted-foreground">{t("ui.models.chooseDefaultAndFallbackModelsFor")}</p></div>
        <div className="flex flex-wrap items-center gap-3 text-sm"><span>{t("models.defaultModeLabel")}</span>
        <Select disabled={busy} onValueChange={value => setSettings({ ...settings, defaultMode: value as GenerationMode })} value={settings.defaultMode}>
          <SelectTrigger aria-label={t("models.defaultModeLabel")} className="w-auto min-w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{modelModes.map(mode => <SelectItem key={mode} value={mode}>{modeNames()[mode]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
        <div className="grid gap-4 lg:grid-cols-3">{modelModes.map(mode => { const models = settings.library.filter(item => item.modes.includes(mode)); return <fieldset key={mode} className="min-w-0 space-y-2 rounded-lg bg-background p-3 shadow-hairline"><legend className="px-1 text-sm font-medium tracking-label">{modeNames()[mode]}</legend>{(["model", "fallback"] as const).map(field => <div className="text-sm" key={field}><span className="block">{field === "model" ? t("models.defaultModelLabel") : t("models.fallbackModelLabel")}</span>
          <Select disabled={busy} onValueChange={value => changeMode(mode, field, fromSelectValue(value))} value={toSelectValue(settings[mode][field])}>
            <SelectTrigger aria-label={`${modeNames()[mode]}${field === "model" ? t("models.defaultModelShort") : t("models.fallbackModelShort")}`} className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{field === "fallback" ? t("models.disableFallback") : t("models.notSet")}</SelectItem>
              {settings[mode][field] && !models.some(item => modelRefKey(item) === modelRefKey(settings[mode][field]!)) && <SelectItem value={modelRefKey(settings[mode][field]!)}>{tf("models.removedPrefix", { value: settings[mode][field]!.modelId })}</SelectItem>}
              {models.map(model => <SelectItem key={modelRefKey(model)} value={modelRefKey(model)}>{model.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>)}</fieldset>; })}</div>
        <div className="text-sm"><span>{t("models.embeddingModelLabel")}</span>
          <Select disabled={busy} onValueChange={value => setSettings({ ...settings, embedding: fromSelectValue(value) })} value={toSelectValue(settings.embedding)}>
            <SelectTrigger aria-label={t("models.embeddingModelLabel")} className="mt-1 w-auto min-w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{t("models.disableEmbedding")}</SelectItem>
              {settings.library.filter(item => item.modes.includes("embedding")).map(item => <SelectItem key={modelRefKey(item)} value={modelRefKey(item)}>{item.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">{t("models.preferencesNote")}</p>
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-background p-3 text-sm shadow-hairline">
          <label className="flex items-center gap-2">
            <input
              checked={settings.thinking.enabled}
              disabled={busy}
              onChange={event => setSettings({ ...settings, thinking: { ...settings.thinking, enabled: event.target.checked } })}
              type="checkbox"
            />
            {t("models.thinkingEnabled")}
          </label>
          <label className="text-xs text-muted-foreground">{t("models.thinkingDescription")}</label>
          <Select
            disabled={busy || !settings.thinking.enabled}
            onValueChange={value => setSettings({ ...settings, thinking: { ...settings.thinking, effort: value === UNSET ? null : (value as "low" | "high" | "max") } })}
            value={settings.thinking.effort ?? UNSET}
          >
            <SelectTrigger aria-label={t("models.thinkingEffortLabel")} className="w-auto min-w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{t("models.thinkingEffortDefault")}</SelectItem>
              <SelectItem value="low">{t("models.thinkingEffort.low")}</SelectItem>
              <SelectItem value="high">{t("models.thinkingEffort.high")}</SelectItem>
              <SelectItem value="max">{t("models.thinkingEffort.max")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {embeddings && <div className="flex flex-wrap items-center gap-3 rounded-lg bg-background p-3 text-sm shadow-hairline">
          <p className="text-muted-foreground">{embeddings.stale > 0 ? tf("models.embeddingStale", { count: embeddings.stale }) : t("models.embeddingStaleNone")}</p>
          <Button disabled={busy || embeddings.stale === 0 || !embeddings.embedding} onClick={() => void run(rebuildEmbeddings)} variant="outline">{t("models.embeddingReindex")}</Button>
        </div>}
        <ContextSettings settings={settings} busy={busy} onChange={setSettings} />
        <fieldset className="space-y-3 rounded-lg bg-background p-3 shadow-hairline">
          <legend className="text-sm font-medium">{t("ui.models.modelCallLimits")}</legend>
          <p className="text-xs text-muted-foreground">{t("ui.models.backgroundCallsAreScheduledReviews")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {([ ["maxConcurrent", t("ui.models.maximumConcurrentCalls"), 1, 16], ["compactionCallsPerTurn", t("ui.models.compactionCallsPerTurn"), 1, 1000], ["backgroundDailyCalls", t("ui.models.dailyBackgroundCalls"), 0, 1000], ["backgroundMaxEstimatedUsd", t("ui.models.estimatedLimitPerBackgroundCallUSD"), 0, 1000000], ["backgroundDailyEstimatedUsd", t("ui.models.estimatedDailyBackgroundLimitUSD"), 0, 1000000] ] as const).map(([key, label, min, max]) => <label key={key} className="text-xs">{label}<Input aria-label={label} type="number" min={min} max={max} step={key.includes("Usd") ? "any" : 1} value={settings.callLimits[key] ?? ""} disabled={busy} onChange={event => setSettings({ ...settings, callLimits: { ...settings.callLimits, [key]: event.target.value === "" && key.includes("Usd") ? null : Number(event.target.value) } })} /></label>)}
            <label className="text-xs">{t("ui.models.budgetTimeZone")}<Input aria-label={t("ui.models.budgetTimeZone")} value={settings.callLimits.timeZone} disabled={busy} onChange={event => setSettings({ ...settings, callLimits: { ...settings.callLimits, timeZone: event.target.value } })} /></label>
          </div>
        </fieldset>
        <details className="rounded-lg bg-background p-3 shadow-hairline"><summary className="cursor-pointer text-sm font-medium tracking-label">{t("models.ratesTitle")}</summary><p className="my-3 text-sm text-muted-foreground">{t("models.ratesDescription")}</p>{rateModels.map(id => <fieldset key={id} className="mb-3 grid gap-2 sm:grid-cols-3"><legend className="break-all font-mono text-xs text-muted-foreground">{id}</legend>{([ ["inputPerMillion", t("models.rateInputLabel")], ["cacheReadPerMillion", t("models.rateCacheReadLabel")], ["cacheWritePerMillion", t("models.rateCacheWriteLabel")], ["outputPerMillion", t("models.rateOutputLabel")], ["perRequest", t("models.rateRequestLabel")] ] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<Input aria-label={`${id} ${label}`} type="number" step="any" min={0} value={settings.rates[id]?.[key] ?? ""} disabled={busy} onChange={event => changeRate(id, key, event.target.value)} /></label>)}</fieldset>)}</details>
        <div className="flex gap-3"><Button disabled={busy} onClick={() => void run(async () => { await settingsRequest("/api/models", jsonRequest("PUT", settings)); setNotice(t("models.notice.preferencesSaved")); })}>{t("models.savePreferences")}</Button><RefreshButton disabled={busy} onClick={() => void run(async () => { await load(); const history = await settingsRequest<{ data: Usage }>(usageSource === "all" ? "/api/usage" : `/api/usage?source=${usageSource}`); setUsage(history.data); setUsageError(""); })} label={t("models.reloadUsage")} /></div>
      </section>
    </>}
    <section id="model-usage" className="models-section flex flex-col gap-5 rounded-xl bg-card p-6 shadow-card" aria-label={t("models.usageLabel")}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold tracking-title">{t("models.usageTitle")}</h2><UsageHistory rows={usage?.recent} source={usageSource} onSourceChange={changeUsageSource} error={localizeMessage(usageError)} /></div><label className="flex items-center gap-3 text-sm">{t("ui.models.callSource")}<SelectField aria-label={t("ui.models.callSource")} value={usageSource} onValueChange={changeUsageSource}><SelectOption value="all">{t("ui.models.allSources")}</SelectOption>{Object.entries(sourceNames()).map(([value, label]) => <SelectOption key={value} value={value}>{label}</SelectOption>)}</SelectField></label>{usageError && <p role="alert" className="text-sm text-destructive">{localizeMessage(usageError)}</p>}<dl className="flex flex-wrap gap-2">
        {[
          { label: t("models.usage.calls"), value: `${usage?.totals.requests ?? 0} ${t("models.usage.times")}` },
          { label: t("models.usage.input"), value: `${usage?.totals.inputTokens ?? t("models.unknown")} Token` },
          { label: t("models.usage.output"), value: `${usage?.totals.outputTokens ?? t("models.unknown")} Token` },
          { label: t("models.usage.knownCost"), value: cost(usage?.totals.costUsd ?? null) },
          { label: t("models.usage.unknownCost"), value: `${usage?.totals.unknownCostRequests ?? 0} ${t("models.usage.times")}` },
        ].map((metric) => (
          <div
            className="min-w-[9rem] rounded-lg border border-border bg-card px-3 py-2 transition-colors duration-[--dur-fast] hover:border-foreground/20"
            key={metric.label}
          >
            <dt className="text-[11px] tracking-label text-muted-foreground">{metric.label}</dt>
            <dd className="mt-0.5 font-mono text-sm tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("models.usageNote")}</p>
      {usage?.controls && <p className="text-xs text-muted-foreground">{t("ui.models.budgetDate")}{usage.controls.day} {t("ui.models.inProgress")}{usage.controls.active}/{usage.controls.maxConcurrent} {t("ui.models.backgroundReserved")}{usage.controls.calls}/{usage.controls.backgroundDailyCalls} {t("ui.models.callsEstimatedBackgroundReservation")}{cost(usage.controls.estimatedUsd)}{t("ui.models.callsWithoutConfiguredPricesMayStill")}</p>}
    </section>
  </main>;
}
