"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssetDetailPanel } from "@/features/media/asset-detail";
import { StoragePanel } from "@/features/media/storage-panel";
import { mediaApi, assetKind, formatBytes, type Asset, type AssetDetail, type Filters, type SourceChat } from "@/features/media/api-client";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { conversationsApi } from "@/features/conversations/api-client";

const defaults: Filters = { type: "all", kind: "all", usage: "all" };
export default function MediaPage() {
  const router = useRouter();
  const [filters, setFilters] = useState(defaults);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<AssetDetail | null>(null);
  const [loading, setLoading] = useState(true);
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
    if (!next) { setAssets([]); setCursor(null); }
    try {
      const result = await mediaApi.list(filters, next);
      if (version !== requests.current.version) return;
      setAssets(previous => next ? [...previous, ...result.data.filter(item => !previous.some(asset => asset.id === item.id))] : result.data);
      setCursor(result.pageInfo.nextCursor);
    } catch (cause) { if (version === requests.current.version) setError(cause instanceof Error ? cause.message : "读取失败。"); }
    finally { if (version === requests.current.version) setLoading(false); }
  }, [filters]);
  useEffect(() => { const current = requests.current; void load(); return () => { current.version++; }; }, [load]);
  async function act(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "媒体操作失败。"); }
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
      if (operation === "delete") { await mediaApi.delete(id); setSelected(null); setNotice("资源已删除，文件无法恢复。"); }
      else { const result = await mediaApi.regenerate(id); await show(result.asset.assetId); setNotice("重新生成完成，已另存新资源，原文件和历史消息未改变。"); }
      setRevision(value => value + 1); await load();
    });
  }
  const disabled = busy || loading;
  return <main className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">媒体资源库</h1><p className="mt-2 text-sm text-muted-foreground">浏览本机图片、视频及附件。查看详情后可下载、重新生成或安全删除。</p></div><Link className="text-sm text-primary underline" href="/chat">返回聊天</Link></header>
    <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">磁盘占用与清理</summary><div className="mt-4"><StoragePanel revision={revision} onChanged={() => { setSelected(null); void load(); }} /></div></details>
    <div className="flex flex-wrap items-end gap-3">
      {([{ key: "type", label: "媒体类型", values: [["all", "全部"], ["image", "图片"], ["video", "视频"]] }, { key: "kind", label: "资源来源", values: [["all", "全部"], ["attachment", "上传附件"], ["generated-image", "生成图片"], ["generated-video", "生成视频"]] }, { key: "usage", label: "引用状态", values: [["all", "全部"], ["referenced", "被引用"], ["unused", "未引用"]] }] as const).map(filter => <label key={filter.key} className="text-sm">{filter.label}<select aria-label={filter.label} className="mt-1 block h-10 min-w-32 rounded-md border bg-background px-3" value={filters[filter.key]} disabled={disabled} onChange={event => { setSelected(null); setFilters({ ...filters, [filter.key]: event.target.value }); }}>{filter.values.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}
      <Button disabled={disabled} variant="outline" onClick={() => { setSelected(null); setRevision(value => value + 1); void load(); }}>刷新资源</Button>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <div ref={detailPanel}>{selected && <AssetDetailPanel key={selected.id} asset={selected} busy={disabled} close={() => setSelected(null)} openChat={openChat} inspect={id => { void act(() => show(id)); }}
      download={() => { void act(async () => { await mediaApi.download(selected.id); setNotice("原文件已交给下载管理器，请妥善保存。"); }); }}
      remove={() => { setOperation("delete"); dialog.current?.showModal(); }} regenerate={() => { setOperation("regenerate"); dialog.current?.showModal(); }} />}</div>
    <p className="text-sm text-muted-foreground" aria-live="polite">已加载 {assets.length} 个资源，按创建时间倒序。</p>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy={disabled}>{assets.map(asset => <article key={asset.id} aria-label={`媒体 ${asset.id}`} className="overflow-hidden rounded-xl border bg-card">
      <button className="flex h-44 w-full items-center justify-center bg-muted/40" aria-label={`查看媒体 ${asset.id}`} disabled={disabled} onClick={() => void act(() => show(asset.id))}>
        {asset.mediaType.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={asset.url} alt={asset.description?.slice(0, 120) || "图片资源"} loading="lazy" className="h-full w-full object-contain" />
          : <span className="text-muted-foreground">▶ 视频 · 打开详情播放</span>}
      </button><div className="space-y-2 p-4"><p className="text-sm font-medium">{assetKind(asset.kind)} · {formatBytes(asset.byteSize)}</p><p className="line-clamp-2 break-words text-sm">{asset.description || "未记录描述"}</p><p className="break-words text-xs text-muted-foreground">{asset.modelId || "未记录模型"} · {asset.referenceCount} 处引用</p><Button disabled={disabled} size="sm" variant="outline" onClick={() => void act(() => show(asset.id))}>查看详情</Button></div>
    </article>)}</div>
    {loading && <p role="status">正在加载媒体…</p>}
    {!assets.length && !loading && !error && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">没有符合条件的媒体资源。</p>}
    {cursor && <Button className="w-full" disabled={disabled} variant="outline" onClick={() => void load(cursor)}>加载更多资源</Button>}
    <p className="text-xs text-muted-foreground">重新生成会再次调用模型，结果可能不同；只有明确确认后才会执行。新结果保存在资源库，不替换历史消息。旧内嵌媒体需先打开对应聊天完成迁移。</p>
    <dialog ref={dialog} aria-labelledby="media-confirm-title" aria-describedby="media-confirm-description" className="w-[min(32rem,90vw)] rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50">
      <h2 id="media-confirm-title" className="text-lg font-semibold">{operation === "delete" ? "永久删除这个资源？" : "按原参数重新生成？"}</h2>
      <p id="media-confirm-description" className="my-4 text-sm">{operation === "delete" ? "文件将从本机永久移除，无法撤销。若出现新的引用，删除会被拒绝。" : "将再次调用原模型，可能产生费用。生成结果另存为新资源，不覆盖原文件或修改历史消息。"}</p>
      <p className="mb-4 break-all text-xs text-muted-foreground">{selected?.id}</p>
      <div className="flex justify-end gap-2"><Button autoFocus disabled={busy} variant="outline" onClick={() => dialog.current?.close()}>取消操作</Button><Button disabled={busy} variant={operation === "delete" ? "destructive" : "default"} onClick={confirm}>{operation === "delete" ? "确认永久删除" : "确认重新生成"}</Button></div>
    </dialog>
  </main>;
}
