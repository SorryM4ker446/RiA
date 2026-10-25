"use client";
import { useLocale } from "@/lib/locale/client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

import { ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { HelpTip } from "@/components/ui/help-tip";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AssetDetailPanel } from "@/features/media/asset-detail";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { StoragePanel } from "@/features/media/storage-panel";
import { mediaApi, assetKind, formatBytes, type Asset, type AssetDetail, type Filters, type SourceChat } from "@/features/media/api-client";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { conversationsApi } from "@/features/conversations/api-client";
import { t, localizeMessage } from "@/lib/locale";
import { animateRemoval, removalKey } from "@/lib/ui/removal";

const defaults: Filters = { type: "all", kind: "all", usage: "all" };
const sameFilters = (a: Filters, b: Filters) => a.type === b.type && a.kind === b.kind && a.usage === b.usage;
export default function MediaPage() {
  useLocale();
  const toast = useToast();
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
  const [revision, setRevision] = useState(0);
  const [operation, setOperation] = useState<"delete" | "regenerate">("delete");
  const dialog = useRef<HTMLDialogElement>(null);
  const requests = useRef({ version: 0 });
  const locked = useRef(false);
  // Kept apart from `selected` so the drawer can slide out while still showing what it showed.
  const [detailOpen, setDetailOpen] = useState(false);
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
    locked.current = true; setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("media.error.act")); }
    finally { locked.current = false; setBusy(false); }
  }
  async function show(id: string) {
    setSelected((await mediaApi.detail(id)).data);
    setDetailOpen(true);
  }
  function openChat(chat: SourceChat) {
    void act(async () => { if (chat.archived) await conversationsApi.update(chat.id, { archived: false }); localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, chat.id); router.push("/chat"); });
  }
  function confirm() {
    if (!selected) return;
    const id = selected.id;
    dialog.current?.close();
    void act(async () => {
      if (operation === "delete") {
        await mediaApi.delete(id); setDetailOpen(false);
        await animateRemoval(id, async () => { setRevision(value => value + 1); await load(); });
        toast(t("media.notice.deleted"));
        return;
      }
      const result = await mediaApi.regenerate(id); await show(result.asset.assetId); toast(t("media.notice.regenerated"));
      setRevision(value => value + 1); await load();
    });
  }
  const disabled = busy || loading;
  const refresh = () => { setSelected(null); setRevision(value => value + 1); void load(); };
  // Read again when the window comes back into view, instead of a refresh button.
  useRefreshOnReturn(() => load());
  return <main className="wide-page mx-auto flex max-w-6xl flex-col gap-7">
    <PageHeader title={t("media.title")} description={t("media.description")} actions={<HelpTip label={t("media.helpLabel")}>{t("media.footnote")}</HelpTip>} />
    <details className="media-storage"><summary className="settings-disclosure-trigger cursor-pointer text-foreground">{t("media.storageSummary")}<ChevronRight className="ml-auto size-4 text-muted-foreground" aria-hidden="true" /></summary><div className="pb-5 pt-1"><StoragePanel embedded revision={revision} onChanged={() => { setSelected(null); void load(); }} /></div></details>
    <div className="flex flex-wrap items-center gap-2">
      {([{ key: "type", label: t("media.filter.typeLabel"), values: [["all", t("media.filter.all")], ["image", t("media.filter.image")], ["video", t("media.filter.video")]] }, { key: "kind", label: t("media.filter.sourceLabel"), values: [["all", t("media.filter.all")], ["attachment", t("media.filter.attachment")], ["generated-image", t("media.filter.generatedImage")], ["generated-video", t("media.filter.generatedVideo")]] }, { key: "usage", label: t("media.filter.usageLabel"), values: [["all", t("media.filter.all")], ["referenced", t("media.filter.referenced")], ["unused", t("media.filter.unused")]] }] as const).map(filter => <Select
          key={filter.key}
          disabled={disabled}
          onValueChange={value => { setSelected(null); setFilters({ ...filters, [filter.key]: value }); }}
          value={filters[filter.key]}
        >
          {/* The filter's name sits inside its trigger, so three selects read apart without a row of labels above them. */}
          <SelectTrigger variant="chip" aria-label={filter.label} className="min-w-0 whitespace-nowrap">
            <span className="mr-1.5 text-muted-foreground">{filter.label}</span><SelectValue className="inline" />
          </SelectTrigger>
          <SelectContent>
            {filter.values.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>)}
      <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">{`${t("media.loaded")} ${assets.length} ${t("media.loadedUnit")}`}</span>
    </div>
    <Reveal className="-mt-7">{error ? <p role="alert" className="mt-7 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline"><span>{localizeMessage(error)}</span><Button size="sm" variant="ghost" className="ml-2 h-auto px-2 py-0.5 align-baseline" onClick={() => void refresh()}>{t("ui.chat.chat-toolbar.retry")}</Button></p> : null}</Reveal>
    <div className="media-grid" aria-busy={disabled}>{assets.map(asset => <article key={asset.id} {...removalKey(asset.id)} aria-label={`${t("media.cardLabel")} ${asset.id}`} className="media-card">
      {/* One control for the whole card: it lies over the image and the text, so a click anywhere opens the details. */}
      <button type="button" className="media-card-open" disabled={disabled} onClick={() => void act(() => show(asset.id))}><span className="sr-only">{t("media.viewDetails")}</span></button>
      <div className="media-card-image flex aspect-square w-full items-center justify-center">
        {asset.mediaType.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={asset.url} alt={asset.description?.slice(0, 120) || t("media.imageAlt")} loading="lazy" className="h-full w-full object-cover" />
          : <span className="text-xs text-muted-foreground">{t("media.videoHint")}</span>}
      </div>
      {/* The caption stays out of the way until the thumbnail is pointed at or focused. */}
      <div className="media-card-caption"><p className="truncate text-xs font-medium">{asset.description || t("media.noDescription")}</p><p className="truncate text-[11px] text-muted-foreground">{`${assetKind(asset.kind)} · ${formatBytes(asset.byteSize)} · ${asset.referenceCount} ${t("media.referenceCount")}`}</p></div>
    </article>)}</div>
    {/* Only announce a load when there is nothing on screen yet. Re-announcing
        it over an intact list is what made a refresh read as a re-render. */}
    {awaitingFirstAssetLoad && <div role="status" aria-label={t("media.loading")} className="media-grid">{[0,1,2,3,4].map(key => <Skeleton key={key} className="aspect-square rounded-xl" />)}</div>}
    {/* One sentence and the one thing to do next. */}
    {!assets.length && !awaitingFirstAssetLoad && !error && <div className="empty-state flex flex-wrap items-center gap-x-3 gap-y-2">
      <span>{t(sameFilters(filters, defaults) ? "media.emptyNone" : "media.empty")}</span>
      {sameFilters(filters, defaults)
        ? <Button asChild size="sm" variant="outline"><Link href="/chat">{t("media.createInChat")}</Link></Button>
        : <Button type="button" size="sm" variant="outline" onClick={() => setFilters(defaults)}>{t("media.filter.reset")}</Button>}
    </div>}
    {cursor && <Button className="self-center" disabled={disabled} variant="ghost" onClick={() => void load(cursor)}>{t("media.loadMore")}</Button>}
    <Sheet open={detailOpen && Boolean(selected)} onOpenChange={open => { if (!open && !busy && !dialog.current?.open) setDetailOpen(false); }}>
      {/* The native confirmation lives inside the drawer, so the drawer's focus trap leaves it alone; the drawer cancels Escape's default, so the confirmation closes itself on Escape and the drawer stays. */}
      <SheetContent side="right" showClose={false} aria-describedby={undefined} className="media-detail-sheet flex flex-col gap-4 overflow-y-auto p-5 sm:p-6">
        <SheetTitle className="sr-only">{t("asset.detailTitle")}</SheetTitle>
        <Reveal className="-mb-4">{error ? <p role="alert" className="mb-4 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p> : null}</Reveal>
        {selected && <AssetDetailPanel key={selected.id} asset={selected} busy={disabled} close={() => setDetailOpen(false)} openChat={openChat} inspect={id => { void act(() => show(id)); }}
          download={() => { void act(async () => { await mediaApi.download(selected.id); toast(t("media.notice.downloaded")); }); }}
          remove={() => { setOperation("delete"); dialog.current?.showModal(); }} regenerate={() => { setOperation("regenerate"); dialog.current?.showModal(); }} />}
        <dialog ref={dialog} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); dialog.current?.close(); } }} aria-labelledby="media-confirm-title" aria-describedby="media-confirm-description" className="w-[min(32rem,90vw)] rounded-lg bg-background p-6 text-foreground shadow-pop backdrop:bg-foreground/30">
          <h2 id="media-confirm-title" className="text-lg font-semibold tracking-title">{operation === "delete" ? t("media.confirmDeleteTitle") : t("media.confirmRegenerateTitle")}</h2>
          <p id="media-confirm-description" className="my-4 text-sm text-muted-foreground">{operation === "delete" ? t("media.confirmDeleteBody") : t("media.confirmRegenerateBody")}</p>
          <p className="mb-4 break-all font-mono text-xs text-muted-foreground">{selected?.id}</p>
          <div className="flex justify-end gap-2"><Button autoFocus disabled={busy} variant="ghost" onClick={() => dialog.current?.close()}>{t("media.cancelAction")}</Button><Button disabled={busy} variant={operation === "delete" ? "destructive" : "default"} onClick={confirm}>{operation === "delete" ? t("media.confirmDeleteAction") : t("media.confirmRegenerateAction")}</Button></div>
        </dialog>
      </SheetContent>
    </Sheet>
  </main>;
}
