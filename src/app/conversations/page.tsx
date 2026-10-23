"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { PageHeader } from "@/components/layout/page-header";
import { ListHead, ToolbarSearch } from "@/components/layout/page-toolbar";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { ConversationRow } from "@/features/conversations/conversation-row";
import { conversationsApi, type Conversation, type Filters } from "@/features/conversations/api-client";
import { animateRemoval } from "@/lib/ui/removal";
const initialFilters: Filters = { q: "", tag: "", state: "active" };
const sameFilters = (a: Filters, b: Filters) => a.q === b.q && a.tag === b.tag && a.state === b.state;
export default function ConversationsPage() {
  useLocale();
  const toast = useToast();
  const router = useRouter();
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  // The query the visible rows came from, so a refresh can distinguish a
  // re-read of the same list from a genuinely new search.
  // The filters the visible rows were actually loaded with — NOT the current
  // ones. Comparing against the live value would always match, because `load`
  // runs from an effect that has already seen the new filters, and a changed
  // filter would then keep the previous query's rows and selection.
  const loadedFilters = useRef(filters);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // The filters are the query: re-running them is silent, changing them earns a
  // first paint again.
  const awaitingFirstChatLoad = useAwaitingFirstLoad(loading, JSON.stringify(filters));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef({ version: 0 });
  const mutating = useRef(false);

  const load = useCallback(async (nextCursor?: string) => {
    const version = ++sequence.current.version;
    setLoading(true); setError("");
    // Same rule as the media list: only a changed query may empty the rows.
    // A plain refresh keeps them and swaps in the new page, so the list never
    // flashes empty mid-request.
    if (!nextCursor && !sameFilters(loadedFilters.current, filters)) { setSelected([]); setChats([]); setCursor(null); }
    try {
      const result = await conversationsApi.list(filters, nextCursor);
      if (version !== sequence.current.version) return;
      loadedFilters.current = filters;
      setChats(previous => nextCursor ? [...previous, ...result.data.filter(chat => !previous.some(item => item.id === chat.id))] : result.data);
      // A reload replaces the rows, so the selection keeps only what is still listed: a deleted or
      // newly hidden conversation would otherwise stay selected and fail the next bulk delete.
      if (!nextCursor) setSelected(previous => previous.filter(id => result.data.some(chat => chat.id === id)));
      setCursor(result.pageInfo.nextCursor);
    } catch (cause) {
      if (version === sequence.current.version) setError(cause instanceof Error ? cause.message : t("conversations.error.load"));
    } finally { if (version === sequence.current.version) setLoading(false); }
  }, [filters]);
  useEffect(() => { const requests = sequence.current; void load(); return () => { requests.version++; }; }, [load]);

  async function act(action: () => Promise<void>) {
    if (mutating.current) return false;
    mutating.current = true; setBusy(true); setError("");
    try { await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("conversations.error.act")); return false; }
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
      toast(t("conversations.notice.updated")); await load();
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
      forgetActive(ids);
      await animateRemoval(ids, load);
      toast(`${t("conversations.notice.deletedBefore")} ${result.data.deletedCount} ${t("conversations.notice.deletedAfter")}`);
    });
  }
  const disabled = loading || busy;
  const columns = { "--cols": "16px minmax(0, 1fr) minmax(0, 8rem) 3.5rem 5.5rem 4.5rem", "--cols-narrow": "16px minmax(0, 1fr) 4rem 4.5rem" } as React.CSSProperties;
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-5">
    <PageHeader back title={t("conversations.title")} description={t("conversations.description")} actions={<RefreshButton iconOnly disabled={disabled} onClick={() => void load()} refreshing={loading && !awaitingFirstChatLoad} label={t("conversations.refreshList")} />} />
    {/* One line of filters: free-text search, a tag, the archive state; Enter or the button applies them. */}
    <form onSubmit={event => { event.preventDefault(); setFilters({ ...draft }); }}>
      <fieldset disabled={busy} className="conversation-filters page-toolbar min-w-0">
        <ToolbarSearch id="conversation-search" aria-label={t("conversations.filter.searchLabel")} value={draft.q} maxLength={200} placeholder={t("ui.conversations.searchTitlesOrMessageText")} onChange={event => setDraft({ ...draft, q: event.target.value })} />
        <input id="conversation-tag" className="toolbar-chip-input" aria-label={t("conversations.filter.tagLabel")} value={draft.tag} maxLength={32} placeholder={t("ui.conversations.filterTags")} onChange={event => setDraft({ ...draft, tag: event.target.value })} />
        <Select onValueChange={value => { const next = { ...draft, state: value as Filters["state"] }; setDraft(next); setFilters(next); }} value={draft.state}>
          <SelectTrigger id="conversation-state" variant="chip" className="w-36" aria-label={t("conversations.filter.stateLabel")}><span className="mr-1.5 text-muted-foreground">{t("ui.columns.status")}</span><SelectValue className="inline" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t("conversations.filter.stateActive")}</SelectItem>
            <SelectItem value="archived">{t("conversations.filter.stateArchived")}</SelectItem>
            <SelectItem value="all">{t("conversations.filter.stateAll")}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" variant="ghost">{t("conversations.filter.submit")}</Button>
        <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => { setDraft(initialFilters); setFilters({ ...initialFilters }); }}>{t("conversations.filter.reset")}</Button>
      </fieldset>
    </form>
    <Reveal className="-mt-5">{error ? <p role="alert" className="mt-5 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p> : null}</Reveal>
    <div className="selection-bar">
      <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{`${t("conversations.counts.loaded")} ${chats.length} ${t("conversations.counts.loadedUnit")} ${t("conversations.counts.divider")} ${t("conversations.counts.selected")} ${selected.length} / 50`}</span>
      <Button variant="ghost" size="sm" disabled={disabled || !chats.length} aria-label={t("conversations.selectFirst50")} onClick={() => setSelected(chats.slice(0, 50).map(chat => chat.id))}>{t("ui.conversations.selectFirst50")}</Button>
      <Button variant="ghost" size="sm" disabled={disabled || !selected.length} onClick={() => setSelected([])}>{t("conversations.clearSelection")}</Button>
      <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" disabled={disabled || !selected.length} onClick={() => dialog.current?.showModal()}>{t("conversations.deleteSelected")}</Button>
    </div>
    <div className={chats.length ? "item-list" : "flex flex-col"} style={columns} aria-busy={disabled}>
      {chats.length ? <ListHead><span /><span>{t("ui.columns.title")}</span><span className="col-optional">{t("ui.columns.tags")}</span><span className="col-end col-optional">{t("ui.columns.messages")}</span><span className="col-end">{t("ui.columns.updated")}</span><span /></ListHead> : null}
      {chats.map(chat => <ConversationRow key={chat.id} chat={chat} selected={selected.includes(chat.id)} disabled={disabled} selectionFull={selected.length >= 50}
        select={() => setSelected(previous => previous.includes(chat.id) ? previous.filter(id => id !== chat.id) : [...previous, chat.id])}
        open={() => open(chat)} update={value => update(chat, value)}
        download={format => { void act(async () => { await conversationsApi.download(chat.id, format); toast(t("conversations.notice.exported")); }); }} />)}
      {!chats.length && !awaitingFirstChatLoad && !error && <p className="empty-state">{t("conversations.empty")}</p>}
      {awaitingFirstChatLoad && <div role="status" aria-label={t("conversations.loading")} className="flex flex-col gap-2">{[0,1,2].map(key => <Skeleton key={key} className="h-20 rounded-xl" />)}</div>}
    </div>
    {cursor && <Button variant="ghost" className="self-center" disabled={disabled} onClick={() => void load(cursor)}>{t("conversations.loadMore")}</Button>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t("conversations.footnote")}</p>
    <dialog ref={dialog} aria-labelledby="delete-title" aria-describedby="delete-description" className="max-h-[80vh] w-[min(32rem,90vw)] overflow-y-auto rounded-lg bg-background p-6 text-foreground shadow-pop backdrop:bg-foreground/30">
      <h2 id="delete-title" className="text-lg font-semibold tracking-title">{`${t("conversations.deleteDialog.titleBefore")} ${selected.length} ${t("conversations.deleteDialog.titleAfter")}`}</h2>
      <p id="delete-description" className="mt-2 text-sm text-muted-foreground">{t("conversations.deleteDialog.description")}</p>
      <ul className="my-4 max-h-48 list-inside list-disc space-y-1 overflow-y-auto text-sm">{chats.filter(chat => selected.includes(chat.id)).map(chat => <li key={chat.id} className="break-words">{chat.title}</li>)}</ul>
      <div className="flex justify-end gap-2"><Button variant="outline" autoFocus onClick={() => dialog.current?.close()}>{t("conversations.deleteDialog.cancel")}</Button><Button variant="destructive" disabled={busy || !selected.length} onClick={removeSelected}>{t("conversations.deleteDialog.confirm")}</Button></div>
    </dialog>
  </main>;
}
