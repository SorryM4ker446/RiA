"use client";
import Link from "next/link";
import { BackToChatLink } from "@/components/layout/back-to-chat-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsRequest, jsonRequest } from "@/features/settings/api-client";
import { libraryModes, modelModes, modelRefKey, type ModelLibraryItem, type ModelPreferences, type ModelRef, type GenerationMode, type LibraryMode } from "@/lib/models/preferences-schema";
import type { LibraryAvailability, ModelAvailability } from "@/lib/models/availability";
import { formatDateTime, t, tf } from "@/lib/locale";

type UsageRow = { id: string; source: string; estimatedUsd: number | null; modelId: string; modelProvider: string; mode: string; status: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costSource: string; fallback: boolean; errorCode: string | null; createdAt: string };
type Usage = { controls?: ModelPreferences["callLimits"] & { day: string; calls: number; estimatedUsd: number; active: number }; recent: UsageRow[]; totals: { requests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; unknownCostRequests: number } };
type CatalogModel = Omit<ModelLibraryItem, "addedAt" | "lastSeenAt">;
type CatalogState = { models: CatalogModel[]; fetchedAt: string | null; stale: boolean; source: "live" | "cache" | "empty"; error: string | null; failure: string | null; skipped: number };
type ProviderSummary = { providerId: string; displayName: string; configured: boolean };
type EmbeddingSummary = { total: number; stale: number; embedding: string | null };
const modeNames: Record<LibraryMode, string> = { chat: t("models.mode.chat"), image: t("models.mode.image"), video: t("models.mode.video"), embedding: t("models.mode.embedding") };
const sourceNames: Record<string, string> = { chat: "聊天", summary: "历史摘要", scheduled: "定时回顾", tool: "工具综合", embedding: "嵌入", media: "媒体生成", unattributed: "来源未记录" };
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
  const [settings, setSettings] = useState<ModelPreferences | null>(null), [usage, setUsage] = useState<Usage | null>(null);
  const [usageSource, setUsageSource] = useState("all");
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
      .then(history => { if (!controller.signal.aborted) setUsage(history.data); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取用量失败"); });
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
  const filteredModels = useMemo(() => (activeCatalog?.models ?? []).filter(item => `${item.modelId} ${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())).slice(0, 300), [activeCatalog, query]);
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
  return <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-headline">{t("models.title")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("models.description")}</p></div><BackToChatLink /></header>
    <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("models.sourceNote")}</p>
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}{warnings.map(warning => <p role="alert" key={warning} className="break-words rounded-lg bg-warning/5 p-3 text-sm text-warning shadow-hairline">{warning}</p>)}
    {settings && <>
      <section className="space-y-4 rounded-lg bg-card p-5 shadow-card" aria-label={t("models.libraryLabel")}><div><h2 className="text-lg font-semibold tracking-title">{t("models.libraryTitle")}</h2><p className="text-sm text-muted-foreground">{t("models.libraryDescription")}</p><p className="text-xs text-muted-foreground">{t("models.availability.note")}</p></div>
        {settings.library.length ? <ul className="grid gap-3 md:grid-cols-2">{settings.library.map(item => <li key={`${item.providerId}:${item.modelId}`} className="animate-row-in min-w-0 rounded-lg bg-elevated p-3 shadow-hairline transition-[box-shadow,transform] duration-[--dur-base] ease-[--ease-out] hover:-translate-y-px hover:shadow-card"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-all font-medium tracking-label">{item.name}</h3><p className="break-all font-mono text-xs text-muted-foreground">{item.modelId}</p><p className="mt-1 text-xs text-muted-foreground">{`${t("models.providerLabel")}: ${providerName(item.providerId)}`}</p>{item.description && <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{item.description}</p>}<div className="mt-2 flex flex-wrap gap-1 text-xs">{item.modes.map(mode => <span className="rounded-full bg-muted px-2 py-0.5" key={mode}>{modeNames[mode]}</span>)}{item.supportsImageInput && <span className="rounded-full bg-muted px-2 py-0.5">{t("models.badge.imageInput")}</span>}{item.modes.includes("image") && <span className="rounded-full bg-muted px-2 py-0.5">{tf("models.badge.imageEndpoint", { status: item.endpointImageInput === null ? t("models.badge.endpointUnverified") : item.endpointImageInput ? t("models.badge.endpointCompatible") : t("models.badge.endpointIncompatible") })}</span>}{item.supportsTools && <span className="rounded-full bg-muted px-2 py-0.5">{t("models.badge.tools")}</span>}<span className={availabilityBadgeClass(availability[modelRefKey(item)]?.state)}>{availabilityLabel(availability[modelRefKey(item)]?.state)}</span>{item.providerSearch && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{t("models.badge.providerSearch")}</span>}</div></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { const result = await settingsRequest<{ data: ModelPreferences }>("/api/models/library", jsonRequest("POST", { action: "remove", model: { providerId: item.providerId, modelId: item.modelId } })); updateSettings(result.data); setNotice(tf("models.removedFromLibrary", { modelId: item.modelId })); })}>{t("models.remove")}</Button></div></li>)}</ul> : <p className="empty-state !p-4 !text-left">{t("models.libraryEmpty")}</p>}
      </section>
      <section className="space-y-4 rounded-lg bg-card p-5 shadow-card" aria-label={t("models.catalogLabel")}><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold tracking-title">{t("models.catalogTitle")}</h2><p className="text-sm text-muted-foreground">{t("models.catalogDescription")}</p></div><RefreshButton disabled={busy} onClick={() => void run(async () => { if (activeProvider) await loadCatalog(activeProvider, catalogMode, true); setNotice(t("models.notice.catalogRefreshed")); })} label={t("models.refreshCatalog")} /></div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("models.providerTabsLabel")}>{providers.map(provider => <Button key={provider.providerId} size="sm" variant={provider.providerId === activeProvider ? "default" : "outline"} onClick={() => { setQuery(""); setCatalogProvider(provider.providerId); }}>{provider.displayName}</Button>)}</div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("models.modeTabsLabel")}>{libraryModes.map(mode => <Button key={mode} size="sm" variant={mode === catalogMode ? "default" : "outline"} onClick={() => { setQuery(""); setCatalogMode(mode); }}>{modeNames[mode]}</Button>)}</div>
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
        <ul className="divide-y rounded-lg bg-background shadow-hairline">{filteredModels.map(item => <li key={modelRefKey(item)} className="flex min-w-0 items-center justify-between gap-3 p-3"><div className="min-w-0"><p className="break-all font-medium tracking-label">{item.name}</p><p className="break-all font-mono text-xs text-muted-foreground">{`${item.modelId}${item.contextLength ? ` ${t("models.divider")} ${item.contextLength.toLocaleString()} context` : ""}${item.supportsImageInput ? ` ${t("models.divider")} ${t("models.catalog.imageInput")}` : ""}${item.supportsTools ? ` ${t("models.divider")} ${t("models.catalog.toolCall")}` : ""}`}</p>{item.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>}{Object.keys(item.pricing).length > 0 && <p className="mt-1 break-words text-xs text-muted-foreground">{tf("models.catalog.pricing", { value: Object.entries(item.pricing).map(([key, value]) => `${key} ${value}`).join(" · ") })}</p>}</div><Button size="sm" variant={added.has(modelRefKey(item)) ? "outline" : "default"} disabled={busy || added.has(modelRefKey(item))} onClick={() => void run(() => addFromCatalog(item))}>{added.has(modelRefKey(item)) ? t("models.alreadyAdded") : t("models.add")}</Button></li>)}</ul>
      </section>
      <section className="space-y-4 rounded-lg bg-card p-5 shadow-card" aria-label={t("models.preferencesLabel")}><div className="flex items-center gap-3 text-sm"><span>{t("models.defaultModeLabel")}</span>
        <Select disabled={busy} onValueChange={value => setSettings({ ...settings, defaultMode: value as GenerationMode })} value={settings.defaultMode}>
          <SelectTrigger aria-label={t("models.defaultModeLabel")} className="w-auto min-w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{modelModes.map(mode => <SelectItem key={mode} value={mode}>{modeNames[mode]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
        <div className="grid gap-4 lg:grid-cols-3">{modelModes.map(mode => { const models = settings.library.filter(item => item.modes.includes(mode)); return <fieldset key={mode} className="min-w-0 space-y-2 rounded-lg bg-background p-3 shadow-hairline"><legend className="px-1 text-sm font-medium tracking-label">{modeNames[mode]}</legend>{(["model", "fallback"] as const).map(field => <div className="text-sm" key={field}><span className="block">{field === "model" ? t("models.defaultModelLabel") : t("models.fallbackModelLabel")}</span>
          <Select disabled={busy} onValueChange={value => changeMode(mode, field, fromSelectValue(value))} value={toSelectValue(settings[mode][field])}>
            <SelectTrigger aria-label={`${modeNames[mode]}${field === "model" ? t("models.defaultModelShort") : t("models.fallbackModelShort")}`} className="mt-1"><SelectValue /></SelectTrigger>
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
        <fieldset className="space-y-3 rounded-lg bg-background p-3 shadow-hairline">
          <legend className="text-sm font-medium">模型调用限制</legend>
          <p className="text-xs text-muted-foreground">后台包括历史摘要和定时回顾。次数按所选时区的本地日期计算；失败、取消和中断仍占当日额度。费用是应用预估，不是供应商账单硬上限；设置费用上限后，缺少价格的后台调用会被拒绝。空费用上限表示不限制。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {([ ["maxConcurrent", "最大并发调用数", 1, 16], ["backgroundDailyCalls", "后台每日调用次数", 0, 1000], ["backgroundMaxEstimatedUsd", "后台单次预估上限 USD", 0, 1000000], ["backgroundDailyEstimatedUsd", "后台每日预估上限 USD", 0, 1000000] ] as const).map(([key, label, min, max]) => <label key={key} className="text-xs">{label}<Input aria-label={label} type="number" min={min} max={max} step={key.includes("Usd") ? "any" : 1} value={settings.callLimits[key] ?? ""} disabled={busy} onChange={event => setSettings({ ...settings, callLimits: { ...settings.callLimits, [key]: event.target.value === "" && key.includes("Usd") ? null : Number(event.target.value) } })} /></label>)}
            <label className="text-xs">预算时区<Input aria-label="预算时区" value={settings.callLimits.timeZone} disabled={busy} onChange={event => setSettings({ ...settings, callLimits: { ...settings.callLimits, timeZone: event.target.value } })} /></label>
          </div>
        </fieldset>
        <details className="rounded-lg bg-background p-3 shadow-hairline"><summary className="cursor-pointer text-sm font-medium tracking-label">{t("models.ratesTitle")}</summary><p className="my-3 text-sm text-muted-foreground">{t("models.ratesDescription")}</p>{rateModels.map(id => <fieldset key={id} className="mb-3 grid gap-2 sm:grid-cols-3"><legend className="break-all font-mono text-xs text-muted-foreground">{id}</legend>{([ ["inputPerMillion", t("models.rateInputLabel")], ["cacheReadPerMillion", t("models.rateCacheReadLabel")], ["cacheWritePerMillion", t("models.rateCacheWriteLabel")], ["outputPerMillion", t("models.rateOutputLabel")], ["perRequest", t("models.rateRequestLabel")] ] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<Input aria-label={`${id} ${label}`} type="number" step="any" min={0} value={settings.rates[id]?.[key] ?? ""} disabled={busy} onChange={event => changeRate(id, key, event.target.value)} /></label>)}</fieldset>)}</details>
        <div className="flex gap-3"><Button disabled={busy} onClick={() => void run(async () => { await settingsRequest("/api/models", jsonRequest("PUT", settings)); setNotice(t("models.notice.preferencesSaved")); })}>{t("models.savePreferences")}</Button><RefreshButton disabled={busy} onClick={() => void run(async () => { await load(); const history = await settingsRequest<{ data: Usage }>(usageSource === "all" ? "/api/usage" : `/api/usage?source=${usageSource}`); setUsage(history.data); })} label={t("models.reloadUsage")} /></div>
      </section>
    </>}
    <section className="space-y-3" aria-label={t("models.usageLabel")}><h2 className="text-lg font-semibold tracking-title">{t("models.usageTitle")}</h2><label className="flex items-center gap-2 text-sm">调用来源<select aria-label="调用来源" className="rounded border bg-background p-2" value={usageSource} onChange={event => setUsageSource(event.target.value)}><option value="all">全部来源</option>{Object.entries(sourceNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><dl className="flex flex-wrap gap-2">
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
      {usage?.controls && <p className="text-xs text-muted-foreground">预算日期 {usage.controls.day} · 进行中 {usage.controls.active}/{usage.controls.maxConcurrent} · 后台已领取 {usage.controls.calls}/{usage.controls.backgroundDailyCalls} 次 · 后台已领取预估 {cost(usage.controls.estimatedUsd)}。价格未配置的调用仍可能产生费用；领取额度不会在失败或取消后返还。</p>}
      <div className="overflow-x-auto rounded-lg bg-card shadow-card"><table className="w-full text-left text-sm"><thead><tr className="border-b bg-muted/50 text-xs uppercase tracking-label text-muted-foreground"><th className="p-3 font-medium">{t("models.thTime")}</th><th className="p-3">{t("models.thResult")}</th><th className="p-3">{t("models.thDuration")}</th><th className="p-3">{t("models.thTokens")}</th><th className="p-3">{t("models.thCost")}</th></tr></thead><tbody>{usage?.recent.map(row => <tr key={row.id} className="border-b transition-colors duration-[--dur-fast] last:border-0 hover:bg-muted/40"><td className="max-w-sm break-words p-3">{row.modelId}<br /><span className="text-xs text-muted-foreground">{row.modelProvider}</span><br /><span className="text-xs text-muted-foreground">{formatDateTime(row.createdAt)} · {row.mode} · {sourceNames[row.source] ?? "来源未记录"}</span></td><td className="p-3">{row.status === "pending" ? "进行中" : row.status === "interrupted" ? "进程中断" : row.status === "success" ? t("models.statusSuccess") : row.status === "aborted" ? t("models.statusAborted") : t("models.statusFailed")}{row.fallback ? t("models.statusFallback") : ""}<br /><span className="text-xs">{row.errorCode}</span></td><td className="whitespace-nowrap p-3">{row.durationMs} ms</td><td className="p-3">{row.inputTokens ?? t("models.unknown")} / {row.outputTokens ?? t("models.unknown")}</td><td className="whitespace-nowrap p-3">{cost(row.costUsd)}<br />{row.estimatedUsd != null && <span className="text-xs">调用前预估 {cost(row.estimatedUsd)}<br /></span>}<span className="text-xs text-muted-foreground">{row.costSource === "provider" ? t("models.costSourceProvider") : row.costSource === "configured" ? t("models.costSourceConfigured") : t("models.costSourceUnknown")}</span></td></tr>)}</tbody></table>{!usage?.recent.length && <p className="p-4 text-sm text-muted-foreground">{t("models.usageEmpty")}</p>}</div>
    </section>
  </main>;
}
