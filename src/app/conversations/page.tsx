"use client";

import Link from "next/link";
import { BackToChatLink } from "@/components/layout/back-to-chat-link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { ConversationRow } from "@/features/conversations/conversation-row";
import { conversationsApi, type Conversation, type Filters } from "@/features/conversations/api-client";
import { t } from "@/lib/locale";

const initialFilters: Filters = { q: "", tag: "", state: "active" };
const sameFilters = (a: Filters, b: Filters) => a.q === b.q && a.tag === b.tag && a.state === b.state;
export default function ConversationsPage() {
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
  const [notice, setNotice] = useState("");
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
      setCursor(result.pageInfo.nextCursor);
    } catch (cause) {
      if (version === sequence.current.version) setError(cause instanceof Error ? cause.message : t("conversations.error.load"));
    } finally { if (version === sequence.current.version) setLoading(false); }
  }, [filters]);
  useEffect(() => { const requests = sequence.current; void load(); return () => { requests.version++; }; }, [load]);

  async function act(action: () => Promise<void>) {
    if (mutating.current) return false;
    mutating.current = true; setBusy(true); setError(""); setNotice("");
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
      setNotice(t("conversations.notice.updated")); await load();
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
      forgetActive(ids); setNotice(`${t("conversations.notice.deletedBefore")} ${result.data.deletedCount} ${t("conversations.notice.deletedAfter")}`); await load();
    });
  }
  const disabled = loading || busy;
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-headline">{t("conversations.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("conversations.description")}</p>
      </div>
      <BackToChatLink />
    </header>
    <form className="rounded-lg bg-card p-4 shadow-card" onSubmit={event => { event.preventDefault(); setNotice(""); setFilters({ ...draft }); }}>
      <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm sm:col-span-2">{t("conversations.filter.searchLabel")}<Input className="mt-1.5" value={draft.q} maxLength={200} placeholder={t("conversations.filter.searchPlaceholder")} onChange={event => setDraft({ ...draft, q: event.target.value })} /></label>
        <label className="text-sm">{t("conversations.filter.tagLabel")}<Input className="mt-1.5" value={draft.tag} maxLength={32} placeholder={t("conversations.filter.tagPlaceholder")} onChange={event => setDraft({ ...draft, tag: event.target.value })} /></label>
        <div className="text-sm"><span>{t("conversations.filter.stateLabel")}</span>
          <Select onValueChange={value => setDraft({ ...draft, state: value as Filters["state"] })} value={draft.state}>
            <SelectTrigger aria-label={t("conversations.filter.stateLabel")} className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t("conversations.filter.stateActive")}</SelectItem>
              <SelectItem value="archived">{t("conversations.filter.stateArchived")}</SelectItem>
              <SelectItem value="all">{t("conversations.filter.stateAll")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2 sm:col-span-2"><Button type="submit">{t("conversations.filter.submit")}</Button><Button type="button" variant="outline" onClick={() => { setDraft(initialFilters); setFilters({ ...initialFilters }); setNotice(""); }}>{t("conversations.filter.reset")}</Button></div>
      </fieldset>
    </form>
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm" aria-live="polite">{`${t("conversations.counts.loaded")} ${chats.length} ${t("conversations.counts.loadedUnit")} ${t("conversations.counts.divider")} ${t("conversations.counts.selected")} ${selected.length} / 50`}</span>
      <Button variant="outline" size="sm" disabled={disabled || !chats.length} onClick={() => setSelected(chats.slice(0, 50).map(chat => chat.id))}>{t("conversations.selectFirst50")}</Button>
      <Button variant="ghost" size="sm" disabled={disabled || !selected.length} onClick={() => setSelected([])}>{t("conversations.clearSelection")}</Button>
      <Button variant="destructive" size="sm" disabled={disabled || !selected.length} onClick={() => dialog.current?.showModal()}>{t("conversations.deleteSelected")}</Button>
      <RefreshButton disabled={disabled} onClick={() => void load()} size="sm" label={t("conversations.refreshList")} variant="ghost" />
    </div>
    <div className="space-y-3" aria-busy={disabled}>
      {chats.map(chat => <ConversationRow key={chat.id} chat={chat} selected={selected.includes(chat.id)} disabled={disabled} selectionFull={selected.length >= 50}
        select={() => setSelected(previous => previous.includes(chat.id) ? previous.filter(id => id !== chat.id) : [...previous, chat.id])}
        open={() => open(chat)} update={value => update(chat, value)}
        download={format => { void act(async () => { await conversationsApi.download(chat.id, format); setNotice(t("conversations.notice.exported")); }); }} />)}
      {!chats.length && !awaitingFirstChatLoad && !error && <p className="empty-state">{t("conversations.empty")}</p>}
      {awaitingFirstChatLoad && <p role="status" className="text-sm text-muted-foreground">{t("conversations.loading")}</p>}
    </div>
    {cursor && <Button variant="outline" className="w-full" disabled={disabled} onClick={() => void load(cursor)}>{t("conversations.loadMore")}</Button>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t("conversations.footnote")}</p>
    <dialog ref={dialog} aria-labelledby="delete-title" aria-describedby="delete-description" className="max-h-[80vh] w-[min(32rem,90vw)] overflow-y-auto rounded-lg bg-background p-6 text-foreground shadow-pop backdrop:bg-foreground/30">
      <h2 id="delete-title" className="text-lg font-semibold tracking-title">{`${t("conversations.deleteDialog.titleBefore")} ${selected.length} ${t("conversations.deleteDialog.titleAfter")}`}</h2>
      <p id="delete-description" className="mt-2 text-sm text-muted-foreground">{t("conversations.deleteDialog.description")}</p>
      <ul className="my-4 max-h-48 list-inside list-disc space-y-1 overflow-y-auto text-sm">{chats.filter(chat => selected.includes(chat.id)).map(chat => <li key={chat.id} className="break-words">{chat.title}</li>)}</ul>
      <div className="flex justify-end gap-2"><Button variant="outline" autoFocus onClick={() => dialog.current?.close()}>{t("conversations.deleteDialog.cancel")}</Button><Button variant="destructive" disabled={busy || !selected.length} onClick={removeSelected}>{t("conversations.deleteDialog.confirm")}</Button></div>
    </dialog>
  </main>;
}
