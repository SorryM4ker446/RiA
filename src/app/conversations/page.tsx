"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { ConversationRow } from "@/features/conversations/conversation-row";
import { conversationsApi, type Conversation, type Filters } from "@/features/conversations/api-client";

const initialFilters: Filters = { q: "", tag: "", state: "active" };
export default function ConversationsPage() {
  const router = useRouter();
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef({ version: 0 });
  const mutating = useRef(false);

  const load = useCallback(async (nextCursor?: string) => {
    const version = ++sequence.current.version;
    setLoading(true); setError("");
    if (!nextCursor) { setSelected([]); setChats([]); setCursor(null); }
    try {
      const result = await conversationsApi.list(filters, nextCursor);
      if (version !== sequence.current.version) return;
      setChats(previous => nextCursor ? [...previous, ...result.data.filter(chat => !previous.some(item => item.id === chat.id))] : result.data);
      setCursor(result.pageInfo.nextCursor);
    } catch (cause) {
      if (version === sequence.current.version) setError(cause instanceof Error ? cause.message : "读取会话失败。");
    } finally { if (version === sequence.current.version) setLoading(false); }
  }, [filters]);
  useEffect(() => { const requests = sequence.current; void load(); return () => { requests.version++; }; }, [load]);

  async function act(action: () => Promise<void>) {
    if (mutating.current) return false;
    mutating.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "会话操作失败。"); return false; }
    finally { mutating.current = false; setBusy(false); }
  }
  function forgetActive(ids: string[]) {
    const active = window.localStorage.getItem(LAST_ACTIVE_CHAT_STORAGE_KEY);
    if (active && ids.includes(active)) window.localStorage.removeItem(LAST_ACTIVE_CHAT_STORAGE_KEY);
  }
  async function update(chat: Conversation, value: { pinned?: boolean; archived?: boolean; tags?: string[] }) {
    return act(async () => {
      await conversationsApi.update(chat.id, value);
      if (value.archived) forgetActive([chat.id]);
      setNotice("会话已更新。"); await load();
    });
  }
  function open(chat: Conversation) {
    void act(async () => {
      if (chat.archived) await conversationsApi.update(chat.id, { archived: false });
      window.localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, chat.id);
      router.push("/chat");
    });
  }
  function removeSelected() {
    const ids = [...selected];
    dialog.current?.close();
    void act(async () => {
      const result = await conversationsApi.delete(ids);
      forgetActive(ids); setNotice(`已删除 ${result.data.deletedCount} 个会话。`); await load();
    });
  }
  const disabled = loading || busy;
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">会话管理</h1><p className="mt-2 text-sm text-muted-foreground">搜索全部历史消息，整理标签与归档。置顶会话优先显示。</p></div>
      <Link className="text-sm text-primary underline underline-offset-4" href="/chat">返回聊天</Link>
    </header>
    <form className="rounded-xl border bg-card p-4" onSubmit={event => { event.preventDefault(); setNotice(""); setFilters({ ...draft }); }}>
      <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm sm:col-span-2">搜索标题和消息正文<Input value={draft.q} maxLength={200} placeholder="输入至少 2 个字符，按原文片段搜索" onChange={event => setDraft({ ...draft, q: event.target.value })} /></label>
        <label className="text-sm">标签筛选<Input value={draft.tag} maxLength={32} placeholder="完整标签，留空显示全部" onChange={event => setDraft({ ...draft, tag: event.target.value })} /></label>
        <label className="text-sm">会话状态<select className="mt-1 flex h-10 w-full rounded-md border bg-background px-3" value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value as Filters["state"] })}>
          <option value="active">未归档</option><option value="archived">已归档</option><option value="all">全部</option>
        </select></label>
        <div className="flex gap-2 sm:col-span-2"><Button type="submit">搜索 / 筛选</Button><Button type="button" variant="outline" onClick={() => { setDraft(initialFilters); setFilters({ ...initialFilters }); setNotice(""); }}>重置</Button></div>
      </fieldset>
    </form>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm" aria-live="polite">已加载 {chats.length} 个 · 已选 {selected.length} / 50</span>
      <Button variant="outline" size="sm" disabled={disabled || !chats.length} onClick={() => setSelected(chats.slice(0, 50).map(chat => chat.id))}>选择前 50 个已加载会话</Button>
      <Button variant="ghost" size="sm" disabled={disabled || !selected.length} onClick={() => setSelected([])}>清除选择</Button>
      <Button variant="destructive" size="sm" disabled={disabled || !selected.length} onClick={() => dialog.current?.showModal()}>删除所选</Button>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void load()}>刷新列表</Button>
    </div>
    <div className="space-y-3" aria-busy={disabled}>
      {chats.map(chat => <ConversationRow key={chat.id} chat={chat} selected={selected.includes(chat.id)} disabled={disabled} selectionFull={selected.length >= 50}
        select={() => setSelected(previous => previous.includes(chat.id) ? previous.filter(id => id !== chat.id) : [...previous, chat.id])}
        open={() => open(chat)} update={value => update(chat, value)}
        download={format => { void act(async () => { await conversationsApi.download(chat.id, format); setNotice("导出已交给下载管理器。文件仅含文本及需要登录的资源引用，请妥善保存。"); }); }} />)}
      {!chats.length && !loading && !error && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">没有符合条件的会话。</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">正在加载会话…</p>}
    </div>
    {cursor && <Button variant="outline" className="w-full" disabled={disabled} onClick={() => void load(cursor)}>加载更多会话</Button>}
    <p className="text-xs leading-relaxed text-muted-foreground">归档只从默认列表隐藏，可随时恢复。导出包含完整会话文本（最多 5,000 条消息），不含媒体文件、工具原始参数或配置密钥，不能用于恢复备份。搜索不包含附件或工具内部参数。</p>
    <dialog ref={dialog} aria-labelledby="delete-title" aria-describedby="delete-description" className="max-h-[80vh] w-[min(32rem,90vw)] overflow-y-auto rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/50">
      <h2 id="delete-title" className="text-lg font-semibold">删除选中的 {selected.length} 个会话？</h2>
      <p id="delete-description" className="mt-2 text-sm text-muted-foreground">会话和消息将永久删除，无法撤销。仍被其他消息引用的媒体会保留；未引用文件由存储管理单独确认清理。</p>
      <ul className="my-4 max-h-48 list-inside list-disc overflow-y-auto text-sm">{chats.filter(chat => selected.includes(chat.id)).map(chat => <li key={chat.id} className="break-words">{chat.title}</li>)}</ul>
      <div className="flex justify-end gap-2"><Button variant="outline" autoFocus onClick={() => dialog.current?.close()}>取消删除</Button><Button variant="destructive" disabled={busy || !selected.length} onClick={removeSelected}>确认永久删除</Button></div>
    </dialog>
  </main>;
}
