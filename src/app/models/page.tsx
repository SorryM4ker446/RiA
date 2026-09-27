"use client";
import Link from "next/link";
import { BackToChatLink } from "@/components/layout/back-to-chat-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsRequest, jsonRequest } from "@/features/settings/api-client";
import { libraryModes, modelModes, type ModelLibraryItem, type ModelPreferences, type GenerationMode, type LibraryMode } from "@/lib/models/preferences-schema";
import { formatDateTime, t, tf } from "@/lib/locale";

type UsageRow = { id: string; modelId: string; mode: string; status: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costSource: string; fallback: boolean; errorCode: string | null; createdAt: string };
type Usage = { recent: UsageRow[]; totals: { requests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; unknownCostRequests: number } };
type CatalogModel = Omit<ModelLibraryItem, "addedAt" | "lastSeenAt">;
type CatalogState = { models: CatalogModel[]; fetchedAt: string | null; stale: boolean; source: "live" | "cache" | "empty"; error: string | null; skipped: number };
const modeNames: Record<LibraryMode, string> = { chat: t("models.mode.chat"), image: t("models.mode.image"), video: t("models.mode.video"), embedding: t("models.mode.embedding") };
const cost = (value: number | null) => value === null ? t("models.unknown") : `$${value.toFixed(6)}`;
// Radix reserves the empty string for "no selection" and throws if an item
// declares it, so "not configured" needs a value that cannot collide with a
// real model id. A model id is always `author/name`, so this prefix is safe.
const UNSET = "__unset__";
const toSelectValue = (id: string | null) => (id ? id : UNSET);
const fromSelectValue = (value: string) => (value === UNSET ? null : value);

export default function ModelsPage() {
  const [settings, setSettings] = useState<ModelPreferences | null>(null), [usage, setUsage] = useState<Usage | null>(null);
  const [catalogMode, setCatalogMode] = useState<LibraryMode>("chat"), [catalogs, setCatalogs] = useState<Partial<Record<LibraryMode, CatalogState>>>({}), [query, setQuery] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [preferences, history] = await Promise.all([
      settingsRequest<{ data: ModelPreferences; recentFailures: { modelId: string }[] }>("/api/models"),
      settingsRequest<{ data: Usage }>("/api/usage"),
    ]);
    setSettings(current => current ? { ...current, ...preferences.data } : preferences.data);
    setUsage(history.data);
    setWarnings([...new Set(preferences.recentFailures.map(item => tf("models.warningForModel", { modelId: item.modelId, reason: t("models.missingModelWarning") })))]);
  }, []);
  const loadCatalog = useCallback(async (mode: LibraryMode, force = false) => {
    const endpoint = force ? "/api/models/catalog" : `/api/models/catalog?mode=${mode}`;
    const response = await settingsRequest<{ catalogs: Partial<Record<LibraryMode, CatalogState>> }>(endpoint, force ? jsonRequest("POST", { mode }) : undefined);
    setCatalogs(current => ({ ...current, ...response.catalogs }));
  }, []);
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : t("models.error.load"))); }, [load]);
  useEffect(() => { if (!catalogs[catalogMode]) void loadCatalog(catalogMode).catch(cause => setError(cause instanceof Error ? cause.message : t("models.error.loadCatalog"))); }, [catalogMode, catalogs, loadCatalog]);
  async function addFromCatalog(item: CatalogModel) {
    const result = await settingsRequest<{ data: ModelLibraryItem; alreadyAdded: boolean }>("/api/models/library", jsonRequest("POST", { action: "add", modelId: item.modelId }));
    setSettings(current => current ? { ...current, library: [...current.library.filter(model => model.modelId !== item.modelId), result.data], legacyCandidates: current.legacyCandidates.filter(candidate => candidate.modelId !== item.modelId) } : current);
    setNotice(result.alreadyAdded ? t("models.notice.capabilityUpdated") : tf("models.notice.addedBefore", { modelId: item.modelId }));
  }
  async function run(operation: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("models.error.act")); } finally { setBusy(false); } }
  function changeMode(mode: GenerationMode, field: "modelId" | "fallbackId", value: string | null) { if (settings) setSettings({ ...settings, [mode]: { ...settings[mode], [field]: value || null } }); }
  function changeRate(id: string, key: "inputPerMillion" | "outputPerMillion" | "perRequest", value: string) { if (settings) setSettings({ ...settings, rates: { ...settings.rates, [id]: { ...(settings.rates[id] ?? { inputPerMillion: null, outputPerMillion: null, perRequest: null }), [key]: value === "" ? null : Number(value) } } }); }
  const rateModels = settings ? [...new Set([...modelModes.flatMap(mode => [settings[mode].modelId, settings[mode].fallbackId].filter((id): id is string => Boolean(id))), settings.embeddingModelId].filter((id): id is string => Boolean(id)))] : [];
  const filteredModels = useMemo(() => (catalogs[catalogMode]?.models ?? []).filter(item => `${item.modelId} ${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())).slice(0, 300), [catalogMode, catalogs, query]);
  const added = useMemo(() => new Set(settings?.library.map(item => item.modelId) ?? []), [settings]);
  function updateSettings(next: ModelPreferences) { setSettings(next); }
  return <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-headline">{t("models.title")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("models.description")}</p></div><BackToChatLink /></header>
    <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t("models.sourceNote")}</p>
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}{warnings.map(warning => <p role="alert" key={warning} className="break-words rounded-lg bg-warning/5 p-3 text-sm text-warning shadow-hairline">{warning}</p>)}
    {settings && <>
      <section className="space-y-4 rounded-lg bg-card p-5 shadow-card" aria-label={t("models.libraryLabel")}><div><h2 className="text-lg font-semibold tracking-title">{t("models.libraryTitle")}</h2><p className="text-sm text-muted-foreground">{t("models.libraryDescription")}</p></div>
        {settings.library.length ? <ul className="grid gap-3 md:grid-cols-2">{settings.library.map(item => <li key={`${item.providerId}:${item.modelId}`} className="animate-row-in min-w-0 rounded-lg bg-elevated p-3 shadow-hairline transition-[box-shadow,transform] duration-[--dur-base] ease-[--ease-out] hover:-translate-y-px hover:shadow-card"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-all font-medium tracking-label">{item.name}</h3><p className="break-all font-mono text-xs text-muted-foreground">{item.modelId}</p>{item.description && <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{item.description}</p>}<div className="mt-2 flex flex-wrap gap-1 text-xs">{item.modes.map(mode => <span className="rounded-full bg-muted px-2 py-0.5" key={mode}>{modeNames[mode]}</span>)}{item.supportsImageInput && <span className="rounded-full bg-muted px-2 py-0.5">{t("models.badge.imageInput")}</span>}{item.modes.includes("image") && <span className="rounded-full bg-muted px-2 py-0.5">{tf("models.badge.imageEndpoint", { status: item.endpointImageInput === null ? t("models.badge.endpointUnverified") : item.endpointImageInput ? t("models.badge.endpointCompatible") : t("models.badge.endpointIncompatible") })}</span>}{item.supportsTools && <span className="rounded-full bg-muted px-2 py-0.5">{t("models.badge.tools")}</span>}</div></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { const result = await settingsRequest<{ data: ModelPreferences }>("/api/models/library", jsonRequest("POST", { action: "remove", modelId: item.modelId })); updateSettings(result.data); setNotice(tf("models.removedFromLibrary", { modelId: item.modelId })); })}>{t("models.remove")}</Button></div></li>)}</ul> : <p className="empty-state !p-4 !text-left">{t("models.libraryEmpty")}</p>}
      </section>
      <section className="space-y-4 rounded-lg bg-card p-5 shadow-card" aria-label={t("models.catalogLabel")}><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold tracking-title">{t("models.catalogTitle")}</h2><p className="text-sm text-muted-foreground">{t("models.catalogDescription")}</p></div><RefreshButton disabled={busy} onClick={() => void run(async () => { await loadCatalog(catalogMode, true); setNotice(t("models.notice.catalogRefreshed")); })} label={t("models.refreshCatalog")} /></div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("models.modeTabsLabel")}>{libraryModes.map(mode => <Button key={mode} size="sm" variant={mode === catalogMode ? "default" : "outline"} onClick={() => { setQuery(""); setCatalogMode(mode); }}>{modeNames[mode]}</Button>)}</div>
        <Input aria-label={t("models.searchLabel")} placeholder={t("models.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
        {catalogs[catalogMode]?.error && <p role="status" className="text-sm text-warning">{catalogs[catalogMode]?.stale ? t("models.notice.catalogStale") : t("models.notice.catalogUnavailable")} {catalogs[catalogMode]?.error}</p>}
        {/* A partial parse is a note, not a failure: the rows that did validate
            are listed below. */}
        {/* A plain note, not a live region: `role="status"` here would collide
            with the page's save confirmation, and nothing about a skipped row
            is announced — it is already visible in the list below. */}
        {!catalogs[catalogMode]?.error && (catalogs[catalogMode]?.skipped ?? 0) > 0 && <p className="text-xs text-muted-foreground">{tf("models.notice.catalogSkipped", { count: catalogs[catalogMode]!.skipped })}</p>}
        <p className="text-xs text-muted-foreground">{`${catalogs[catalogMode]?.models.length ?? 0} ${t("models.catalog.countUnit")}${catalogs[catalogMode]?.fetchedAt ? ` ${t("models.divider")} ${t("models.catalog.updatedAt")} ${formatDateTime(catalogs[catalogMode]!.fetchedAt!)}` : ""}${catalogs[catalogMode]?.stale ? ` ${t("models.divider")} ${t("models.catalog.cachedData")}` : ""} ${t("models.divider")} ${t("models.catalog.limit")}`}</p>
        <ul className="divide-y rounded-lg bg-background shadow-hairline">{filteredModels.map(item => <li key={item.modelId} className="flex min-w-0 items-center justify-between gap-3 p-3"><div className="min-w-0"><p className="break-all font-medium tracking-label">{item.name}</p><p className="break-all font-mono text-xs text-muted-foreground">{`${item.modelId}${item.contextLength ? ` ${t("models.divider")} ${item.contextLength.toLocaleString()} context` : ""}${item.supportsImageInput ? ` ${t("models.divider")} ${t("models.catalog.imageInput")}` : ""}${item.supportsTools ? ` ${t("models.divider")} ${t("models.catalog.toolCall")}` : ""}`}</p>{item.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>}{Object.keys(item.pricing).length > 0 && <p className="mt-1 break-words text-xs text-muted-foreground">{tf("models.catalog.pricing", { value: Object.entries(item.pricing).map(([key, value]) => `${key} ${value}`).join(" · ") })}</p>}</div><Button size="sm" variant={added.has(item.modelId) ? "outline" : "default"} disabled={busy || added.has(item.modelId)} onClick={() => void run(() => addFromCatalog(item))}>{added.has(item.modelId) ? t("models.alreadyAdded") : t("models.add")}</Button></li>)}</ul>
      </section>
      <section className="space-y-4 rounded-lg bg-card p-5 shadow-card" aria-label={t("models.preferencesLabel")}><div className="flex items-center gap-3 text-sm"><span>{t("models.defaultModeLabel")}</span>
        <Select disabled={busy} onValueChange={value => setSettings({ ...settings, defaultMode: value as GenerationMode })} value={settings.defaultMode}>
          <SelectTrigger aria-label={t("models.defaultModeLabel")} className="w-auto min-w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{modelModes.map(mode => <SelectItem key={mode} value={mode}>{modeNames[mode]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
        <div className="grid gap-4 lg:grid-cols-3">{modelModes.map(mode => { const models = settings.library.filter(item => item.modes.includes(mode)); return <fieldset key={mode} className="min-w-0 space-y-2 rounded-lg bg-background p-3 shadow-hairline"><legend className="px-1 text-sm font-medium tracking-label">{modeNames[mode]}</legend>{(["modelId", "fallbackId"] as const).map(field => <div className="text-sm" key={field}><span className="block">{field === "modelId" ? t("models.defaultModelLabel") : t("models.fallbackModelLabel")}</span>
          <Select disabled={busy} onValueChange={value => changeMode(mode, field, fromSelectValue(value))} value={toSelectValue(settings[mode][field])}>
            <SelectTrigger aria-label={`${modeNames[mode]}${field === "modelId" ? t("models.defaultModelShort") : t("models.fallbackModelShort")}`} className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{field === "fallbackId" ? t("models.disableFallback") : t("models.notSet")}</SelectItem>
              {settings[mode][field] && !models.some(item => item.modelId === settings[mode][field]) && <SelectItem value={settings[mode][field]!}>{tf("models.removedPrefix", { value: settings[mode][field]! })}</SelectItem>}
              {models.map(model => <SelectItem key={model.modelId} value={model.modelId}>{model.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>)}</fieldset>; })}</div>
        <div className="text-sm"><span>{t("models.embeddingModelLabel")}</span>
          <Select disabled={busy} onValueChange={value => setSettings({ ...settings, embeddingModelId: fromSelectValue(value) })} value={toSelectValue(settings.embeddingModelId)}>
            <SelectTrigger aria-label={t("models.embeddingModelLabel")} className="mt-1 w-auto min-w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{t("models.disableEmbedding")}</SelectItem>
              {settings.library.filter(item => item.modes.includes("embedding")).map(item => <SelectItem key={item.modelId} value={item.modelId}>{item.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">{t("models.preferencesNote")}</p>
        <details className="rounded-lg bg-background p-3 shadow-hairline"><summary className="cursor-pointer text-sm font-medium tracking-label">{t("models.ratesTitle")}</summary><p className="my-3 text-sm text-muted-foreground">{t("models.ratesDescription")}</p>{rateModels.map(id => <fieldset key={id} className="mb-3 grid gap-2 sm:grid-cols-3"><legend className="break-all font-mono text-xs text-muted-foreground">{id}</legend>{([ ["inputPerMillion", t("models.rateInputLabel")], ["outputPerMillion", t("models.rateOutputLabel")], ["perRequest", t("models.rateRequestLabel")] ] as const).map(([key, label]) => <label key={key} className="text-xs">{label}<Input aria-label={`${id} ${label}`} type="number" step="any" min={0} value={settings.rates[id]?.[key] ?? ""} disabled={busy} onChange={event => changeRate(id, key, event.target.value)} /></label>)}</fieldset>)}</details>
        <div className="flex gap-3"><Button disabled={busy} onClick={() => void run(async () => { await settingsRequest("/api/models", jsonRequest("PUT", settings)); setNotice(t("models.notice.preferencesSaved")); })}>{t("models.savePreferences")}</Button><RefreshButton disabled={busy} onClick={() => void run(load)} label={t("models.reloadUsage")} /></div>
      </section>
    </>}
    <section className="space-y-3" aria-label={t("models.usageLabel")}><h2 className="text-lg font-semibold tracking-title">{t("models.usageTitle")}</h2><dl className="flex flex-wrap gap-2">
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
      <div className="overflow-x-auto rounded-lg bg-card shadow-card"><table className="w-full text-left text-sm"><thead><tr className="border-b bg-muted/50 text-xs uppercase tracking-label text-muted-foreground"><th className="p-3 font-medium">{t("models.thTime")}</th><th className="p-3">{t("models.thResult")}</th><th className="p-3">{t("models.thDuration")}</th><th className="p-3">{t("models.thTokens")}</th><th className="p-3">{t("models.thCost")}</th></tr></thead><tbody>{usage?.recent.map(row => <tr key={row.id} className="border-b transition-colors duration-[--dur-fast] last:border-0 hover:bg-muted/40"><td className="max-w-sm break-words p-3">{row.modelId}<br /><span className="text-xs text-muted-foreground">{formatDateTime(row.createdAt)} · {row.mode}</span></td><td className="p-3">{row.status === "success" ? t("models.statusSuccess") : row.status === "aborted" ? t("models.statusAborted") : t("models.statusFailed")}{row.fallback ? t("models.statusFallback") : ""}<br /><span className="text-xs">{row.errorCode}</span></td><td className="whitespace-nowrap p-3">{row.durationMs} ms</td><td className="p-3">{row.inputTokens ?? t("models.unknown")} / {row.outputTokens ?? t("models.unknown")}</td><td className="whitespace-nowrap p-3">{cost(row.costUsd)}<br /><span className="text-xs text-muted-foreground">{row.costSource === "provider" ? t("models.costSourceProvider") : row.costSource === "configured" ? t("models.costSourceConfigured") : t("models.costSourceUnknown")}</span></td></tr>)}</tbody></table>{!usage?.recent.length && <p className="p-4 text-sm text-muted-foreground">{t("models.usageEmpty")}</p>}</div>
    </section>
  </main>;
}
