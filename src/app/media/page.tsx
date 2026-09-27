"use client";
import Link from "next/link";
import { BackToChatLink } from "@/components/layout/back-to-chat-link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AssetDetailPanel } from "@/features/media/asset-detail";
import { StoragePanel } from "@/features/media/storage-panel";
import { mediaApi, assetKind, formatBytes, type Asset, type AssetDetail, type Filters, type SourceChat } from "@/features/media/api-client";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { conversationsApi } from "@/features/conversations/api-client";
import { t } from "@/lib/locale";

const defaults: Filters = { type: "all", kind: "all", usage: "all" };
const sameFilters = (a: Filters, b: Filters) => a.type === b.type && a.kind === b.kind && a.usage === b.usage;
export default function MediaPage() {
  const router = useRouter();
  const [filters, setFilters] = useState(defaults);
  // The filters the currently displayed rows were fetched with, so a refresh
  // can tell "same query, re-read it" apart from "different query, start over".
  // The filters the visible rows were actually loaded with — see the note in
  // the conversations list; the same distinction applies here.
  const loadedFilters = useRef(filters);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // The filters are the query: re-running them is silent, changing them earns a
  // first paint again.
  const awaitingFirstAssetLoad = useAwaitingFirstLoad(loading, JSON.stringify(filters));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [operation, setOperation] = useState<"delete" | "regenerate">("delete");
  const dialog = useRef<HTMLDialogElement>(null);
  const requests = useRef({ version: 0 });
  const locked = useRef(false);
  const detailPanel = useRef<HTMLDivElement>(null);
  const load = useCallback(async (next?: string) => {
    const version = ++requests.current.version;
    setLoading(true); setError("");
    // A refresh keeps the rows already on screen and swaps them when the
    // response lands. Clearing first emptied the grid for the length of the
    // request, so every refresh flashed: content out, empty state in, content
    // back. Only a filter change is allowed to blank the list, because those
    // rows genuinely no longer match.
    if (!next && !sameFilters(loadedFilters.current, filters)) { setAssets([]); setCursor(null); }
    try {
      const result = await mediaApi.list(filters, next);
      if (version !== requests.current.version) return;
      loadedFilters.current = filters;
      setAssets(previous => next ? [...previous, ...result.data.filter(item => !previous.some(asset => asset.id === item.id))] : result.data);
      setCursor(result.pageInfo.nextCursor);
    } catch (cause) { if (version === requests.current.version) setError(cause instanceof Error ? cause.message : t("media.error.load")); }
    finally { if (version === requests.current.version) setLoading(false); }
  }, [filters]);
  useEffect(() => { const current = requests.current; void load(); return () => { current.version++; }; }, [load]);
  async function act(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("media.error.act")); }
    finally { locked.current = false; setBusy(false); }
  }
  async function show(id: string) {
    setSelected((await mediaApi.detail(id)).data);
    requestAnimationFrame(() => detailPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function openChat(chat: SourceChat) {
    void act(async () => { if (chat.archived) await conversationsApi.update(chat.id, { archived: false }); localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, chat.id); router.push("/chat"); });
  }
  function confirm() {
    if (!selected) return;
    const id = selected.id;
    dialog.current?.close();
    void act(async () => {
      if (operation === "delete") { await mediaApi.delete(id); setSelected(null); setNotice(t("media.notice.deleted")); }
      else { const result = await mediaApi.regenerate(id); await show(result.asset.assetId); setNotice(t("media.notice.regenerated")); }
      setRevision(value => value + 1); await load();
    });
  }
  const disabled = busy || loading;
  return <main className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-headline">{t("media.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("media.description")}</p>
      </div>
      <BackToChatLink />
    </header>
    <details className="rounded-lg bg-card p-4 shadow-card"><summary className="cursor-pointer text-sm font-medium tracking-label">{t("media.storageSummary")}</summary><div className="mt-4"><StoragePanel revision={revision} onChanged={() => { setSelected(null); void load(); }} /></div></details>
    <div className="flex flex-wrap items-end gap-3">
      {([{ key: "type", label: t("media.filter.typeLabel"), values: [["all", t("media.filter.all")], ["image", t("media.filter.image")], ["video", t("media.filter.video")]] }, { key: "kind", label: t("media.filter.sourceLabel"), values: [["all", t("media.filter.all")], ["attachment", t("media.filter.attachment")], ["generated-image", t("media.filter.generatedImage")], ["generated-video", t("media.filter.generatedVideo")]] }, { key: "usage", label: t("media.filter.usageLabel"), values: [["all", t("media.filter.all")], ["referenced", t("media.filter.referenced")], ["unused", t("media.filter.unused")]] }] as const).map(filter => <div key={filter.key} className="text-sm"><span className="block">{filter.label}</span>
        <Select
          disabled={disabled}
          onValueChange={value => { setSelected(null); setFilters({ ...filters, [filter.key]: value }); }}
          value={filters[filter.key]}
        >
          <SelectTrigger aria-label={filter.label} className="mt-1.5 min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filter.values.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>)}
      <RefreshButton
        disabled={disabled}
        onClick={() => { setSelected(null); setRevision(value => value + 1); void load(); }}
        refreshing={loading}
        label={t("media.refresh")}
      />
    </div>
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <div ref={detailPanel}>{selected && <AssetDetailPanel key={selected.id} asset={selected} busy={disabled} close={() => setSelected(null)} openChat={openChat} inspect={id => { void act(() => show(id)); }}
      download={() => { void act(async () => { await mediaApi.download(selected.id); setNotice(t("media.notice.downloaded")); }); }}
      remove={() => { setOperation("delete"); dialog.current?.showModal(); }} regenerate={() => { setOperation("regenerate"); dialog.current?.showModal(); }} />}</div>
    <p className="text-sm text-muted-foreground" aria-live="polite">{`${t("media.loaded")} ${assets.length} ${t("media.loadedUnit")}`}</p>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy={disabled}>{assets.map(asset => <article key={asset.id} aria-label={`${t("media.cardLabel")} ${asset.id}`} className="overflow-hidden rounded-lg bg-card shadow-card transition-shadow duration-200 hover:shadow-raised">
      <button className="flex h-44 w-full items-center justify-center bg-muted" aria-label={`${t("media.viewLabel")} ${asset.id}`} disabled={disabled} onClick={() => void act(() => show(asset.id))}>
        {asset.mediaType.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={asset.url} alt={asset.description?.slice(0, 120) || t("media.imageAlt")} loading="lazy" className="h-full w-full object-contain" />
          : <span className="text-muted-foreground">{t("media.videoHint")}</span>}
      </button><div className="space-y-2 p-4"><p className="text-sm font-medium tracking-label">{assetKind(asset.kind)} · {formatBytes(asset.byteSize)}</p><p className="line-clamp-2 break-words text-sm text-muted-foreground">{asset.description || t("media.noDescription")}</p><p className="break-words text-xs text-muted-foreground">{`${asset.modelId || t("media.noModel")} · ${asset.referenceCount} ${t("media.referenceCount")}`}</p><Button disabled={disabled} size="sm" variant="outline" onClick={() => void act(() => show(asset.id))}>{t("media.viewDetails")}</Button></div>
    </article>)}</div>
    {/* Only announce a load when there is nothing on screen yet. Re-announcing
        it over an intact list is what made a refresh read as a re-render. */}
    {awaitingFirstAssetLoad && <p role="status">{t("media.loading")}</p>}
    {!assets.length && !awaitingFirstAssetLoad && !error && <p className="empty-state">{t("media.empty")}</p>}
    {cursor && <Button className="w-full" disabled={disabled} variant="outline" onClick={() => void load(cursor)}>{t("media.loadMore")}</Button>}
    <p className="text-xs text-muted-foreground">{t("media.footnote")}</p>
    <dialog ref={dialog} aria-labelledby="media-confirm-title" aria-describedby="media-confirm-description" className="w-[min(32rem,90vw)] rounded-lg bg-background p-6 text-foreground shadow-pop backdrop:bg-foreground/30">
      <h2 id="media-confirm-title" className="text-lg font-semibold tracking-title">{operation === "delete" ? t("media.confirmDeleteTitle") : t("media.confirmRegenerateTitle")}</h2>
      <p id="media-confirm-description" className="my-4 text-sm text-muted-foreground">{operation === "delete" ? t("media.confirmDeleteBody") : t("media.confirmRegenerateBody")}</p>
      <p className="mb-4 break-all font-mono text-xs text-muted-foreground">{selected?.id}</p>
      <div className="flex justify-end gap-2"><Button autoFocus disabled={busy} variant="outline" onClick={() => dialog.current?.close()}>{t("media.cancelAction")}</Button><Button disabled={busy} variant={operation === "delete" ? "destructive" : "default"} onClick={confirm}>{operation === "delete" ? t("media.confirmDeleteAction") : t("media.confirmRegenerateAction")}</Button></div>
    </dialog>
  </main>;
}
