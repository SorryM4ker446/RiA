"use client";
import { useLocale } from "@/lib/locale/client";

import { formatDateTime, t, tf, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";
import { PageHeader } from "@/components/layout/page-header";
import { ToolbarSearch } from "@/components/layout/page-toolbar";
import { Reveal } from "@/components/ui/reveal";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CatalogResults } from "@/features/models/catalog-results";
import { ContextSettings } from "@/features/models/context-settings";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsRequest, jsonRequest } from "@/features/settings/api-client";
import { callLimitRanges, libraryModes, modelModes, modelRefKey, type ModelLibraryItem, type ModelPreferences, type ModelRef, type GenerationMode, type LibraryMode } from "@/lib/models/preferences-schema";
import type { LibraryAvailability, LibraryModelFailure, ModelAvailability } from "@/lib/models/availability";
import type { CatalogModel } from "@/lib/models/providers/types";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSettingsDirty } from "@/features/settings/settings-context";
import { announceModelPreferencesChanged } from "@/features/models/preference-events";
type CatalogState = { models: CatalogModel[]; fetchedAt: string | null; stale: boolean; source: "live" | "cache" | "empty"; error: string | null; failure: string | null; skipped: number };
type ProviderSummary = { providerId: string; displayName: string; configured: boolean };
type EmbeddingSummary = { total: number; stale: number; embedding: string | null };
const modeNames = (): Record<LibraryMode, string> => ({ chat: t("models.mode.chat"), image: t("models.mode.image"), video: t("models.mode.video"), embedding: t("models.mode.embedding") });
// Radix reserves the empty string for "no selection" and throws if an item
// declares it, so "not configured" needs a value that cannot collide with a
// real selection. Selections carry a provider prefix, so this cannot collide
// with one either.
const UNSET = "__unset__";
const toSelectValue = (ref: ModelRef | null) => (ref ? modelRefKey(ref) : UNSET);
type CallLimitKey = keyof typeof callLimitRanges;
const callLimitFields = (): [CallLimitKey, string][] => [
  ["maxConcurrent", t("ui.models.maximumConcurrentCalls")],
  ["compactionCallsPerTurn", t("ui.models.compactionCallsPerTurn")],
  ["backgroundDailyCalls", t("ui.models.dailyBackgroundCalls")],
  ["backgroundMaxEstimatedUsd", t("ui.models.estimatedLimitPerBackgroundCallUSD")],
  ["backgroundDailyEstimatedUsd", t("ui.models.estimatedDailyBackgroundLimitUSD")],
];
/** The call limits the server would refuse, found before saving so each can be pointed out where it is typed. */
function callLimitProblems(limits: ModelPreferences["callLimits"]) {
  const problems = new Set<CallLimitKey | "timeZone">();
  for (const key of Object.keys(callLimitRanges) as CallLimitKey[]) {
    const range = callLimitRanges[key], value = limits[key];
    if (value === null && !range.integer) continue;
    if (value === null || !Number.isFinite(value) || value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) problems.add(key);
  }
  try {
    if (!limits.timeZone || limits.timeZone.length > 100) throw new RangeError(limits.timeZone);
    new Intl.DateTimeFormat("en", { timeZone: limits.timeZone });
  } catch { problems.add("timeZone"); }
  return problems;
}
/** The part of the preferences this section edits and saves; the library is changed one model at a time and saved at once. */
const preferenceKey = (value: ModelPreferences) => JSON.stringify({ ...value, library: undefined, legacyCandidates: undefined });
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * Applies what was edited here since `base` onto `latest`, one field deep. The
 * default chat model and the backup limits are also set from other sections of
 * the settings, so a save from here must not put back the values it loaded.
 */
function applyEdits(base: ModelPreferences, edited: ModelPreferences, latest: ModelPreferences): ModelPreferences {
  const before = base as unknown as Record<string, unknown>, now = latest as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...now };
  for (const [key, value] of Object.entries(edited)) {
    if (key === "library" || key === "legacyCandidates" || sameValue(value, before[key])) continue;
    const original = before[key], current = now[key];
    next[key] = isRecord(value) && isRecord(original) && isRecord(current)
      ? { ...current, ...Object.fromEntries(Object.entries(value).filter(([field, fieldValue]) => !sameValue(fieldValue, original[field]))) }
      : value;
  }
  return next as unknown as ModelPreferences;
}
const fromSelectValue = (value: string): ModelRef | null => {
  if (value === UNSET) return null;
  const [providerId, ...rest] = value.split(":");
  return rest.length ? { providerId: providerId as ModelRef["providerId"], modelId: rest.join(":") } : null;
};

/** The model library, the official catalogs, and the defaults and limits every call follows. */
export function ModelSettings() {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [settings, setSettings] = useState<ModelPreferences | null>(null);
  // The preferences as last loaded or saved, to tell an edit in progress from what is stored.
  const [savedPreferences, setSavedPreferences] = useState<ModelPreferences | null>(null);
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
  const [warnings, setWarnings] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    const preferences = await settingsRequest<{ data: ModelPreferences; availability: LibraryAvailability; providers: ProviderSummary[]; recentFailures: LibraryModelFailure[] }>("/api/models");
    setSettings(current => current ? { ...current, ...preferences.data } : preferences.data);
    setSavedPreferences(preferences.data);
    setAvailability(preferences.availability ?? {});
    setProviders(preferences.providers ?? []);
    setWarnings(preferences.recentFailures.map(item => tf("models.notFoundOn", { modelId: item.modelId, date: formatDateTime(item.failedAt, { month: "short", day: "numeric" }) })));
    // The embedding summary is an aside on this page. A failure reading it must
    // not take the library, the catalog and the preferences down with it, so it
    // settles on its own and only reports itself.
    settingsRequest<{ data: EmbeddingSummary }>("/api/memory/reindex")
      .then(response => setEmbeddings(response.data))
      .catch(() => setEmbeddings(null));
  }, []);
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
    const result = await settingsRequest<{ data: ModelLibraryItem; alreadyAdded: boolean; defaulted: GenerationMode[] }>("/api/models/library", jsonRequest("POST", { action: "add", model: { providerId: item.providerId, modelId: item.modelId } }));
    // The server may also have made it the default for modes that had none. Both
    // the form and its saved copy take that in, so it does not read as an unsaved edit.
    const ref: ModelRef = { providerId: result.data.providerId, modelId: result.data.modelId };
    const merge = (current: ModelPreferences | null) => current ? {
      ...current, ...Object.fromEntries(result.defaulted.map(mode => [mode, { ...current[mode], model: ref }])),
      library: [...current.library.filter(model => modelRefKey(model) !== key), result.data],
      legacyCandidates: current.legacyCandidates.filter(candidate => modelRefKey(candidate.ref) !== key),
    } : current;
    setSettings(merge);
    setSavedPreferences(merge);
    announceModelPreferencesChanged();
    toast(result.alreadyAdded ? tf("models.notice.addedBefore", { modelId: item.modelId })
      : result.defaulted.length ? tf("models.notice.addedAsDefault", { modelId: item.modelId }) : tf("models.notice.added", { modelId: item.modelId }));
  }
  async function run(operation: () => Promise<void>) { setBusy(true); setError(""); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("models.error.act")); } finally { setBusy(false); } }
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
  function updateSettings(next: ModelPreferences) { setSettings(next); setSavedPreferences(next); announceModelPreferencesChanged(); }
  useSettingsDirty(Boolean(settings && savedPreferences && preferenceKey(settings) !== preferenceKey(savedPreferences)));
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

  /**
   * Rebuilding is paid work, so it asks first.
   */
  async function rebuildEmbeddings() {
    if (!(await confirm({ title: t("ui.confirm.rebuildEmbeddings"), description: t("models.embeddingReindexConfirm") }))) return;
    const response = await settingsRequest<{ data: { reindexed: number; remaining: number } }>("/api/memory/reindex", jsonRequest("POST", { confirm: true }));
    toast(tf("models.notice.embeddingReindexed", { reindexed: response.data.reindexed, remaining: response.data.remaining }));
    setEmbeddings(current => current ? { ...current, stale: response.data.remaining } : current);
  }
  const limitProblems = settings ? callLimitProblems(settings.callLimits) : new Set<CallLimitKey | "timeZone">();
  return <>
    <PageHeader level={2} title={t("ui.settingsOverlay.models")} description={t("ui.settingsOverlay.modelsDescription")} />
    <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("models.sourceNote")}</p>
    <Reveal className="-mt-7">{error ? <p role="alert" className="mt-7 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p> : null}</Reveal>{warnings.map(warning => <p role="alert" key={warning} className="break-words rounded-lg bg-warning/5 p-3 text-sm text-warning shadow-hairline">{warning}</p>)}
    {settings && <>
      <section id="model-library" className="models-section page-section flex flex-col gap-4" aria-label={t("models.libraryLabel")}><div className="flex items-baseline gap-2"><h2 className="text-base font-semibold tracking-title">{t("models.libraryTitle")}</h2><span className="text-xs text-muted-foreground">{settings.library.length}</span></div>
        {settings.library.length ? <ul className="item-list" style={{ "--cols": "minmax(0, 1fr) 5.5rem 3.5rem", "--cols-narrow": "minmax(0, 1fr) 3.5rem" } as React.CSSProperties}>{settings.library.map(item => <li key={`${item.providerId}:${item.modelId}`} className="item-row data-row catalog-library-row min-w-0"><div className="flex min-w-0 flex-col gap-0.5"><h3 className="break-all text-sm font-medium tracking-label">{item.name}</h3><p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"><span className="break-all font-mono">{item.modelId}</span><span>· {providerName(item.providerId)}</span></p><p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">{[...item.modes.map(mode => modeNames()[mode]), ...(item.supportsImageInput ? [t("models.badge.imageInput")] : []), ...(item.modes.includes("image") ? [tf("models.badge.imageEndpoint", { status: item.endpointImageInput === null ? t("models.badge.endpointUnverified") : item.endpointImageInput ? t("models.badge.endpointCompatible") : t("models.badge.endpointIncompatible") })] : []), ...(item.supportsTools ? [t("models.badge.tools")] : [])].join(" · ")}{item.providerSearch && <Status tone="warning">{t("models.badge.providerSearch")}</Status>}</p></div><Status className="col-optional col-end" tone={(availability[modelRefKey(item)]?.state ?? "ready") === "ready" ? "success" : "warning"}>{availabilityLabel(availability[modelRefKey(item)]?.state)}</Status><Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => void run(async () => { const result = await settingsRequest<{ data: ModelPreferences }>("/api/models/library", jsonRequest("POST", { action: "remove", model: { providerId: item.providerId, modelId: item.modelId } })); updateSettings(result.data); toast(tf("models.removedFromLibrary", { modelId: item.modelId })); })}>{t("models.remove")}</Button></li>)}</ul> : <p className="empty-state !p-4 !text-left">{t("models.libraryEmpty")}</p>}
      </section>
      <section id="model-catalog" className="models-section page-section flex flex-col gap-5" aria-label={t("models.catalogLabel")}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-col gap-2"><h2 className="text-base font-semibold tracking-title">{t("models.catalogTitle")}</h2><p className="text-sm leading-6 text-muted-foreground">{t("models.catalogDescription")}</p></div><RefreshButton iconOnly disabled={busy} onClick={() => void run(async () => { if (activeProvider) await loadCatalog(activeProvider, catalogMode, true); toast(t("models.notice.catalogRefreshed")); })} label={t("models.refreshCatalog")} /></div>
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
        <ToolbarSearch aria-label={t("models.searchLabel")} placeholder={t("models.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
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
      <section id="model-preferences" className="models-section page-section flex flex-col gap-5" aria-label={t("models.preferencesLabel")}>
        <div className="flex flex-col gap-2"><h2 className="text-base font-semibold tracking-title">{t("ui.models.defaultsCallSettings")}</h2><p className="text-sm text-muted-foreground">{t("ui.models.chooseDefaultAndFallbackModelsFor")}</p></div>
        {/* One setting per row: what it is on the left, its control on the right. */}
        <div className="setting-rows">
          <div className="setting-row"><span className="setting-row-label">{t("models.defaultModeLabel")}</span>
            <Select disabled={busy} onValueChange={value => setSettings({ ...settings, defaultMode: value as GenerationMode })} value={settings.defaultMode}>
              <SelectTrigger aria-label={t("models.defaultModeLabel")} className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>{modelModes.map(mode => <SelectItem key={mode} value={mode}>{modeNames()[mode]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {modelModes.map(mode => { const models = settings.library.filter(item => item.modes.includes(mode)); return <div role="group" aria-label={modeNames()[mode]} key={mode} className="setting-row">
            <span className="setting-row-label">{modeNames()[mode]}<span className="setting-row-hint">{t("models.defaultModelLabel")} / {t("models.fallbackModelLabel")}</span></span>
            <div className="flex flex-wrap justify-end gap-2">{(["model", "fallback"] as const).map(field => <Select key={field} disabled={busy} onValueChange={value => changeMode(mode, field, fromSelectValue(value))} value={toSelectValue(settings[mode][field])}>
              <SelectTrigger aria-label={`${modeNames()[mode]}${field === "model" ? t("models.defaultModelShort") : t("models.fallbackModelShort")}`} className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>{field === "fallback" ? t("models.disableFallback") : t("models.notSet")}</SelectItem>
                {settings[mode][field] && !models.some(item => modelRefKey(item) === modelRefKey(settings[mode][field]!)) && <SelectItem value={modelRefKey(settings[mode][field]!)}>{tf("models.removedPrefix", { value: settings[mode][field]!.modelId })}</SelectItem>}
                {models.map(model => <SelectItem key={modelRefKey(model)} value={modelRefKey(model)}>{model.name}</SelectItem>)}
              </SelectContent>
            </Select>)}</div>
          </div>; })}
          <div className="setting-row"><span className="setting-row-label">{t("models.embeddingModelLabel")}</span>
            <Select disabled={busy} onValueChange={value => setSettings({ ...settings, embedding: fromSelectValue(value) })} value={toSelectValue(settings.embedding)}>
              <SelectTrigger aria-label={t("models.embeddingModelLabel")} className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>{t("models.disableEmbedding")}</SelectItem>
                {settings.library.filter(item => item.modes.includes("embedding")).map(item => <SelectItem key={modelRefKey(item)} value={modelRefKey(item)}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {embeddings && <div className="setting-row"><span className="setting-row-label">{t("models.embeddingReindex")}<span className="setting-row-hint">{embeddings.stale > 0 ? tf("models.embeddingStale", { count: embeddings.stale }) : t("models.embeddingStaleNone")}</span></span>
            <Button size="sm" disabled={busy || embeddings.stale === 0 || !embeddings.embedding} onClick={() => void run(rebuildEmbeddings)} variant="ghost">{t("models.embeddingReindex")}</Button>
          </div>}
          <div className="setting-row"><label className="flex min-w-0 flex-[1_1_12rem] items-center gap-3">
              <input checked={settings.thinking.enabled} disabled={busy} onChange={event => setSettings({ ...settings, thinking: { ...settings.thinking, enabled: event.target.checked } })} type="checkbox" />
              <span className="flex flex-col">{t("models.thinkingEnabled")}<span className="setting-row-hint">{t("models.thinkingDescription")}</span></span>
            </label>
            <Select disabled={busy || !settings.thinking.enabled} onValueChange={value => setSettings({ ...settings, thinking: { ...settings.thinking, effort: value === UNSET ? null : (value as "low" | "high" | "max") } })} value={settings.thinking.effort ?? UNSET}>
              <SelectTrigger aria-label={t("models.thinkingEffortLabel")} className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>{t("models.thinkingEffortDefault")}</SelectItem>
                <SelectItem value="low">{t("models.thinkingEffort.low")}</SelectItem>
                <SelectItem value="high">{t("models.thinkingEffort.high")}</SelectItem>
                <SelectItem value="max">{t("models.thinkingEffort.max")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <ContextSettings settings={settings} busy={busy} onChange={setSettings} />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t("ui.models.modelCallLimits")}</legend>
          <p className="text-xs text-muted-foreground">{t("ui.models.backgroundCallsAreScheduledReviews")}</p>
          <div className="setting-rows">
            {callLimitFields().map(([key, label]) => {
              const range = callLimitRanges[key], value = settings.callLimits[key], invalid = limitProblems.has(key);
              const bounds = { min: range.min.toLocaleString("en-US"), max: range.max.toLocaleString("en-US") };
              return <Field key={key} orientation="horizontal" className="setting-row" data-invalid={invalid || undefined}>
                <span className="setting-row-label"><FieldLabel htmlFor={`call-limit-${key}`}>{label}</FieldLabel>
                {invalid
                  ? <FieldError id={`call-limit-${key}-hint`} className="text-xs">{tf(range.integer ? "ui.models.limitInvalidInteger" : "ui.models.limitInvalidUsd", bounds)}</FieldError>
                  : <FieldDescription id={`call-limit-${key}-hint`} className="setting-row-hint">{tf(range.integer ? "ui.models.limitRangeInteger" : "ui.models.limitRangeUsd", bounds)}</FieldDescription>}</span>
                <Input id={`call-limit-${key}`} className="w-44" aria-describedby={`call-limit-${key}-hint`} aria-invalid={invalid || undefined} type="number" inputMode={range.integer ? "numeric" : "decimal"} min={range.min} max={range.max} step={range.integer ? 1 : "any"} value={value === null || Number.isNaN(value) ? "" : value} disabled={busy}
                  onChange={event => setSettings({ ...settings, callLimits: { ...settings.callLimits, [key]: event.target.value === "" ? (range.integer ? Number.NaN : null) : Number(event.target.value) } })} />
              </Field>;
            })}
            <Field orientation="horizontal" className="setting-row" data-invalid={limitProblems.has("timeZone") || undefined}>
              <span className="setting-row-label"><FieldLabel htmlFor="call-limit-timeZone">{t("ui.models.budgetTimeZone")}</FieldLabel>
              {limitProblems.has("timeZone")
                ? <FieldError id="call-limit-timeZone-hint" className="text-xs">{t("ui.models.timeZoneInvalid")}</FieldError>
                : <FieldDescription id="call-limit-timeZone-hint" className="setting-row-hint">{t("ui.models.timeZoneHint")}</FieldDescription>}</span>
              <Input id="call-limit-timeZone" className="w-44" aria-describedby="call-limit-timeZone-hint" aria-invalid={limitProblems.has("timeZone") || undefined} value={settings.callLimits.timeZone} disabled={busy} onChange={event => setSettings({ ...settings, callLimits: { ...settings.callLimits, timeZone: event.target.value } })} />
            </Field>
          </div>
        </fieldset>
        <details className="settings-disclosure"><summary className="settings-disclosure-trigger cursor-pointer text-foreground">{t("models.ratesTitle")}</summary><p className="my-3 text-sm text-muted-foreground">{t("models.ratesDescription")}</p>{rateModels.map(id => <fieldset key={id} className="mb-3 grid gap-2 sm:grid-cols-3"><legend className="break-all font-mono text-xs text-muted-foreground">{id}</legend>{([ ["inputPerMillion", t("models.rateInputLabel")], ["cacheReadPerMillion", t("models.rateCacheReadLabel")], ["cacheWritePerMillion", t("models.rateCacheWriteLabel")], ["outputPerMillion", t("models.rateOutputLabel")], ["perRequest", t("models.rateRequestLabel")] ] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<Input aria-label={`${id} ${label}`} type="number" step="any" min={0} value={settings.rates[id]?.[key] ?? ""} disabled={busy} onChange={event => changeRate(id, key, event.target.value)} /></label>)}</fieldset>)}</details>
        {/* Saving belongs to the settings above it, so it sits in their footer rather than floating after the last field. */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/55 pt-4"><p role={limitProblems.size ? "status" : undefined} className={limitProblems.size ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{limitProblems.size ? t("ui.models.fixLimitsBeforeSaving") : t("models.preferencesNote")}</p><Button size="sm" disabled={busy || limitProblems.size > 0} onClick={() => void run(async () => { const { data: latest } = await settingsRequest<{ data: ModelPreferences }>("/api/models"); const saved = await settingsRequest<{ data: ModelPreferences }>("/api/models", jsonRequest("PUT", savedPreferences ? applyEdits(savedPreferences, settings, latest) : settings)); updateSettings(saved.data); toast(t("models.notice.preferencesSaved")); })}>{t("models.savePreferences")}</Button></footer>
      </section>
    </>}
  </>;
}
