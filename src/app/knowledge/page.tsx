"use client";
import { useLocale } from "@/lib/locale/client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

import { formatDateTime, t, tf, localizeMessage } from "@/lib/locale";
import { Status } from "@/components/ui/status";

import { SelectField, SelectOption } from "@/components/ui/select";

import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { FormEvent, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { AlertCircle, BookOpen, Check, ChevronRight, MoreHorizontal, PencilLine, Plus, Search, Trash2, Upload } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/layout/page-header";
import { ToolbarSearch } from "@/components/layout/page-toolbar";
import { Reveal } from "@/components/ui/reveal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTrigger } from "@/components/ui/dialog";
import { useConfirmDiscard } from "@/components/ui/discard-guard";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { DocumentLibrary } from "@/features/knowledge/document-library";
import { searchDocumentContent } from "@/features/knowledge/document-client";
import { KnowledgeEntryContent } from "@/features/knowledge/entry-content";
import { presentToolMemory } from "@/features/knowledge/entry-presentation";
import type { DocumentSource } from "@/lib/documents/types";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
type KnowledgeEntry = {
  id: string;
  key: string;
  value: string;
  score: number | null;
  source: "manual" | "assistant";
  confirmed: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeView = "all" | "confirmed" | "candidates";
type EntryPage = { q: string; view: KnowledgeView; cursors: Array<string | null>; nextCursor: string | null };
const firstEntryPage: EntryPage = { q: "", view: "all", cursors: [null], nextCursor: null };

/** The knowledge page is an overview, or the full view of one kind of content. */
type PageView = "overview" | "documents" | "entries";
/** How many entries the overview lists before "All" leads to the full view. */
const OVERVIEW_ENTRIES = 5;
/** Typing filters entries once it pauses this long; the knowledge list is rate limited per minute. */
const ENTRY_SEARCH_PAUSE_MS = 350;

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The part of a title that matched the search, marked. */
function markMatch(text: string, query: string): ReactNode {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark className="knowledge-match">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

// The view lives in the address (?view=documents | entries), so it reads the search params, which
// Next.js renders on the client below the nearest Suspense boundary.
export default function KnowledgePage() {
  return <Suspense fallback={null}><KnowledgeWorkspace /></Suspense>;
}

/**
 * Documents and knowledge entries. The overview shows the latest few of each, one search over both
 * and what needs a decision (entries waiting to be confirmed); "All" opens the full view of one kind,
 * with its filters, search and paging, so the page grows by a level rather than in length.
 */
function KnowledgeWorkspace() {
  useLocale();
  const params = useSearchParams();
  const router = useRouter();
  const requested = params.get("view");
  const view: PageView = requested === "documents" || requested === "entries" ? requested : "overview";
  const requestedFilter: KnowledgeView = view === "entries" && params.get("filter") === "candidates" ? "candidates" : "all";
  const go = (next: PageView, query: Record<string, string> = {}) =>
    router.push(next === "overview" ? "/knowledge" : `/knowledge?${new URLSearchParams({ view: next, ...query })}`);

  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entryPage, setEntryPage] = useState<EntryPage>(firstEntryPage);
  const [pageNeedsRefresh, setPageNeedsRefresh] = useState(false);
  const [search, setSearch] = useState("");
  const entryRequest = useRef<AbortController | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const mayDiscard = useConfirmDiscard();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // How many entries wait to be confirmed: a short page of them is enough to say "some, or many".
  const [pending, setPending] = useState<{ count: number; more: boolean } | null>(null);
  // The overview's one search: entries as you type, document content on request.
  const [overviewQuery, setOverviewQuery] = useState("");
  const [documentHits, setDocumentHits] = useState<DocumentSource[] | null>(null);
  const [searchingDocuments, setSearchingDocuments] = useState(false);
  const documentSearch = useRef<AbortController | null>(null);
  const [persona, setPersona] = useState({ name: "", language: "", answerStyle: "", notes: "" });
  const [isSavingPersona, setIsSavingPersona] = useState(false);

  async function loadPersona() {
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload?.data?.persona) setPersona(payload.data.persona);
    } catch {
      // The card stays editable even when the current values cannot be read.
    }
  }

  async function savePersona() {
    setIsSavingPersona(true);
    setError(null);
    try {
      const current = await (await fetch("/api/models", { cache: "no-store" })).json();
      // The server keeps ownership of the library, so the change is sent on top
      // of what it holds rather than overwriting the whole document.
      const response = await fetch("/api/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...current.data, persona }),
      });
      if (!response.ok) throw new Error(readApiErrorMessage(await response.json(), t("knowledge.error.update")));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("knowledge.error.update"));
    } finally {
      setIsSavingPersona(false);
    }
  }
  const [editingValue, setEditingValue] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const awaitingFirstEntryLoad = useAwaitingFirstLoad(isLoading, "entries");

  async function loadEntries(target: EntryPage = pageNeedsRefresh ? { ...entryPage, cursors: [null], nextCursor: null } : entryPage) {
    entryRequest.current?.abort();
    const controller = new AbortController();
    entryRequest.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "25", view: target.view });
      if (target.q) params.set("q", target.q);
      const cursor = target.cursors.at(-1);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/knowledge?${params}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.load")));
      }

      if (controller.signal.aborted) return;
      setEntries(Array.isArray(payload.data) ? payload.data : []);
      setEntryPage({ ...target, nextCursor: payload.pageInfo?.nextCursor ?? null });
      setPageNeedsRefresh(false);
      if (target.q !== entryPage.q || target.view !== entryPage.view || target.cursors.length !== entryPage.cursors.length) {
        setEditingId(null);
      }
    } catch (loadError) {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : t("knowledge.error.load"));
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }

  async function loadPending() {
    try {
      const response = await fetch("/api/knowledge?view=candidates&limit=10", { cache: "no-store" });
      const payload = await response.json();
      if (response.ok) setPending({ count: Array.isArray(payload.data) ? payload.data.length : 0, more: Boolean(payload.pageInfo?.nextCursor) });
    } catch {
      // Without the count the overview simply does not mention pending entries.
    }
  }

  async function searchDocuments() {
    const query = overviewQuery.trim();
    if (!query) return;
    documentSearch.current?.abort();
    const controller = new AbortController();
    documentSearch.current = controller;
    setSearchingDocuments(true);
    setError(null);
    try {
      const found = await searchDocumentContent(query, [], controller.signal);
      if (!controller.signal.aborted) setDocumentHits(found.sources);
    } catch (searchError) {
      if (!controller.signal.aborted) setError(searchError instanceof Error ? searchError.message : t("documents.requestFailed"));
    } finally {
      if (documentSearch.current === controller) { documentSearch.current = null; setSearchingDocuments(false); }
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving || isLoading) return;
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) {
      setError(t("knowledge.error.required"));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: normalizedKey,
          value: normalizedValue,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.save")));
      }

      setKey("");
      setValue("");
      setPageNeedsRefresh(true);
      await loadEntries({ ...entryPage, cursors: [null], nextCursor: null });
      void loadPending();
      setCreateOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("knowledge.error.save"));
    } finally {
      setIsSaving(false);
    }
  }

  /**
   * Applies an edit or an acceptance to one entry. The list is updated from the
   * response rather than optimistically, so what the page shows is what was
   * stored — including a write that quietly did nothing.
   */
  async function updateEntry(entryId: string, body: { value?: string; confirmed?: boolean }) {
    if (isSaving || isLoading) return;
    setIsSaving(true);
    setError(null);
    // Accepting a suggestion shows at once; a refused save puts it back.
    const before = entries.find(entry => entry.id === entryId);
    if (body.confirmed !== undefined && body.value === undefined) setEntries(current => current.map(entry => (entry.id === entryId ? { ...entry, confirmed: body.confirmed! } : entry)));
    try {
      const response = await fetch(`/api/knowledge/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.update")));
      }
      setEntries((current) => current.map((entry) => (entry.id === entryId ? payload.data : entry)));
      setEditingId(null);
      setPageNeedsRefresh(true);
      await loadEntries({ ...entryPage, cursors: [null], nextCursor: null });
      void loadPending();
    } catch (updateError) {
      if (before) setEntries(current => current.map(entry => (entry.id === entryId ? before : entry)));
      setError(updateError instanceof Error ? updateError.message : t("knowledge.error.update"));
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteEntry(entryId: string) {
    if (isSaving || isLoading) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${entryId}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.delete")));
      }
      await animateRemoval(entryId, () => setEntries((current) => current.filter((entry) => entry.id !== entryId)));
      if (editingId === entryId) setEditingId(null);
      setPageNeedsRefresh(true);
      await loadEntries({ ...entryPage, cursors: [null], nextCursor: null });
      void loadPending();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("knowledge.error.delete"));
    } finally {
      setIsSaving(false);
    }
  }

  // Each view starts from its own first page: the overview from the latest entries, the entries
  // view from the filter it was opened with. Nothing typed in one view carries into another.
  useEffect(() => {
    setSearch("");
    setOverviewQuery("");
    setDocumentHits(null);
    if (view === "entries") setImportOpen(false);
    void loadEntries({ ...firstEntryPage, view: requestedFilter });
    return () => entryRequest.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the view or its filter changes
  }, [view, requestedFilter]);

  useEffect(() => {
    void loadPending();
    void loadPersona();
    return () => documentSearch.current?.abort();
  }, []);

  // Typing filters entries once it pauses: in the overview's search, and in the entries view's own.
  const typed = (view === "overview" ? overviewQuery : view === "entries" ? search : "").trim();
  useEffect(() => {
    if (view === "documents" || typed === entryPage.q) return;
    const timer = window.setTimeout(() => void loadEntries({ ...entryPage, q: typed, cursors: [null], nextCursor: null }), ENTRY_SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the typed text only
  }, [typed, view]);

  // Read again when the window comes back into view, instead of a refresh button.
  useRefreshOnReturn(() => { void loadEntries(); void loadPending(); });

  const searching = view === "overview" && overviewQuery.trim().length > 0;
  const trail = <nav className="page-trail" aria-label={t("knowledge.path")}>
    <span className="page-trail-step"><button type="button" onClick={() => go("overview")}>{t("knowledge.title")}</button></span>
  </nav>;
  const importAction = <Button size="sm" aria-expanded={importOpen} onClick={() => setImportOpen(open => !open)}><Upload data-icon="inline-start" />{t("documents.import")}</Button>;

  // Leaving the new entry without saving asks first when something was written, and then drops it.
  async function closeCreator() {
    if (isSaving || !(await mayDiscard(Boolean(key.trim() || value.trim())))) return;
    // A refusal of the entry just dropped has nothing left to refer to.
    setKey(""); setValue(""); setError(null); setCreateOpen(false);
  }
  const entryCreator = (trigger: ReactNode) => (
    <Dialog open={createOpen} onOpenChange={open => { if (!open) void closeCreator(); else if (!isSaving) { setCreateOpen(true); setError(null); } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent closeLabel={t("ui.knowledge.closeNewKnowledgeEntry")}>
        <DialogHeader title={t("knowledge.createTitle")} description={t("knowledge.createDescription")} />
        <form className="dialog-form" onSubmit={onSubmit}>
          <DialogBody>
            <Reveal>{error ? <Alert variant="destructive"><AlertTitle>{t("knowledge.error.title")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}</Reveal>
            <FieldGroup><Field><FieldLabel htmlFor="knowledge-entry-key">{t("knowledge.keyPlaceholder")}</FieldLabel><Input id="knowledge-entry-key" disabled={isSaving} onChange={event => setKey(event.target.value)} placeholder={t("knowledge.keyPlaceholder")} value={key} /></Field><Field><FieldLabel htmlFor="knowledge-entry-value">{t("knowledge.valuePlaceholder")}</FieldLabel><Textarea id="knowledge-entry-value" disabled={isSaving} rows={8} onChange={event => setValue(event.target.value)} placeholder={t("knowledge.valuePlaceholder")} value={value} /></Field></FieldGroup>
          </DialogBody>
          <DialogFooter><Button type="button" variant="ghost" disabled={isSaving} onClick={() => void closeCreator()}>{t("knowledge.cancelEdit")}</Button><Button disabled={isSaving || isLoading} type="submit">{isSaving ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}{t("knowledge.create")}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  const entryRows = (items: KnowledgeEntry[], highlight = "") => (
    // The skeleton is a first-load placeholder, not a refresh state: a refresh keeps the
    // entries on screen, so it never reads as a page reload.
    awaitingFirstEntryLoad ? (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ) : items.length === 0 ? (
      <Empty className="py-6"><EmptyHeader><EmptyMedia><BookOpen /></EmptyMedia><EmptyTitle>{entryPage.q || entryPage.view !== "all" || entryPage.cursors.length > 1 ? t("knowledge.noMatches") : t("knowledge.empty")}</EmptyTitle><EmptyDescription>{t("ui.knowledge.addReusableInformationOrConfirmKnowledge")}</EmptyDescription></EmptyHeader></Empty>
    ) : (
      <div className="item-list">
        {items.map((entry) => {
          const toolMemory = presentToolMemory(entry.key, entry.value);
          const title = toolMemory?.title ?? entry.key;
          const actionLabel = toolMemory ? `${toolMemory.toolLabel} · ${title}` : title;
          return (
            <article className="item-row item-row-stack knowledge-entry-row min-w-0" key={entry.id} {...removalKey(entry.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{markMatch(title, highlight)}</h3>
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"><span>{toolMemory?.toolLabel ?? t(`knowledge.source.${entry.source}`)}</span>{!entry.confirmed ? <Status tone="warning">{t("knowledge.candidateBadge")}</Status> : null}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!entry.confirmed ? (
                    <Button disabled={isSaving || isLoading} onClick={() => void updateEntry(entry.id, { confirmed: true })} size="sm" type="button" variant="ghost">
                      <Check data-icon="inline-start" />{t("knowledge.accept")}
                    </Button>
                  ) : null}
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={tf("ui.assistants.moreActionsFor", { v0: actionLabel })} disabled={isSaving || isLoading}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {editingId !== entry.id ? <DropdownMenuItem aria-label={`${t("knowledge.edit")} ${actionLabel}`} onSelect={() => { setEditingId(entry.id); setEditingValue(entry.value); }}><PencilLine aria-hidden="true" />{t("knowledge.edit")}</DropdownMenuItem> : null}
                      {editingId !== entry.id ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuItem variant="destructive" aria-label={`${t("knowledge.deleteLabel")} ${actionLabel}`} onSelect={() => void deleteEntry(entry.id)}><Trash2 aria-hidden="true" />{t("documents.delete")}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              {editingId === entry.id ? (
                <div className="surface-enter flex flex-col gap-2">
                  <Textarea aria-label={t("knowledge.editValueLabel")} onChange={(event) => setEditingValue(event.target.value)} rows={3} value={editingValue} />
                  <div className="flex gap-2">
                    <Button disabled={isSaving || isLoading} onClick={() => void updateEntry(entry.id, { value: editingValue })} size="sm" type="button">{t("knowledge.saveEdit")}</Button>
                    <Button disabled={isSaving} onClick={() => setEditingId(null)} size="sm" type="button" variant="ghost">{t("knowledge.cancelEdit")}</Button>
                  </div>
                </div>
              ) : <KnowledgeEntryContent entryKey={entry.key} value={entry.value} toolMemory={toolMemory} />}
              {!entry.confirmed ? <p className="text-xs text-muted-foreground">{t("knowledge.candidateNote")}</p> : null}
              <p className="break-words text-xs leading-5 text-muted-foreground">
                {t("knowledge.updatedAt")} <time dateTime={entry.updatedAt}>{formatTime(entry.updatedAt)}</time> {t("knowledge.divider")} {entry.lastUsedAt ? <>{t("knowledge.lastUsed")} <time dateTime={entry.lastUsedAt}>{formatTime(entry.lastUsedAt)}</time></> : t("knowledge.neverUsed")}
              </p>
            </article>
          );
        })}
      </div>
    )
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
      {view === "documents" ? <PageHeader trail={trail} title={t("knowledge.documentsTitle")} description={t("knowledge.documentsDescription")} actions={importAction} />
        : view === "entries" ? <PageHeader trail={trail} title={t("knowledge.entriesTitle")} description={t("knowledge.entriesViewDescription")} actions={entryCreator(<Button size="sm"><Plus data-icon="inline-start" />{t("knowledge.create")}</Button>)} />
        : <PageHeader title={t("knowledge.title")} description={t("knowledge.description")} actions={importAction} />}

      <Reveal className="-mt-6">{error && !createOpen ? (
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>{t("knowledge.error.title")}</AlertTitle>
          <AlertDescription><span>{localizeMessage(error)}</span><Button size="sm" variant="ghost" className="ml-2 h-auto px-2 py-0.5 align-baseline" onClick={() => void loadEntries()}>{t("ui.chat.chat-toolbar.retry")}</Button></AlertDescription>
        </Alert>
      ) : null}</Reveal>

      {view === "overview" ? (
        <form role="search" className="page-toolbar" onSubmit={event => { event.preventDefault(); void searchDocuments(); }}>
          <ToolbarSearch id="knowledge-search" aria-label={t("knowledge.overviewSearch.label")} placeholder={t("knowledge.overviewSearch.placeholder")} maxLength={120} value={overviewQuery}
            onChange={event => { setOverviewQuery(event.target.value); setDocumentHits(null); documentSearch.current?.abort(); }}
            onKeyDown={event => { if (event.key === "Escape" && overviewQuery) { event.preventDefault(); setOverviewQuery(""); setDocumentHits(null); } }} />
        </form>
      ) : null}

      {searching ? (
        <section aria-label={t("knowledge.overviewSearch.label")} aria-busy={isLoading || searchingDocuments} className="knowledge-search-results">
          <p className="knowledge-search-group">{tf("knowledge.overviewSearch.entries", { count: `${entries.length}${entryPage.nextCursor ? "+" : ""}` })}</p>
          {entries.length || isLoading ? entryRows(entries, overviewQuery.trim()) : <p className="text-sm text-muted-foreground">{t("knowledge.overviewSearch.noEntries")}</p>}
          <p className="knowledge-search-group">{t("knowledge.overviewSearch.documents")}</p>
          <button type="button" className="knowledge-search-action" disabled={searchingDocuments} onClick={() => void searchDocuments()}>
            {searchingDocuments ? <Spinner /> : <Search aria-hidden="true" />}
            <span>{searchingDocuments ? t("knowledge.overviewSearch.searching") : tf("knowledge.overviewSearch.searchDocuments", { query: overviewQuery.trim() })}</span>
            <kbd>{t("knowledge.overviewSearch.enter")}</kbd>
          </button>
          {documentHits?.length === 0 ? <p role="status" className="text-sm leading-6 text-muted-foreground">{t("documents.noMatches")}</p> : null}
          <DocumentSources sources={documentHits ?? []} />
        </section>
      ) : null}

      {/* One library in the same place for the overview and its own view, so an open import survives the step between them. */}
      {view !== "entries" ? <DocumentLibrary mode={view === "documents" ? "full" : "overview"} hidden={searching} importOpen={importOpen} onImportClose={() => setImportOpen(false)} onShowAll={() => go("documents")} /> : null}

      {view === "overview" ? (
        <section aria-label={t("knowledge.entriesTitle")} aria-busy={isLoading} className={searching ? "hidden" : "flex min-w-0 flex-col gap-4 pt-3"} hidden={searching}>
          <header className="knowledge-section-head justify-between">
            <h2 className="text-base font-semibold tracking-title">{t("knowledge.entriesTitle")}</h2>
            <div className="flex items-center gap-3">
              {pending?.count ? <button type="button" className="knowledge-pending" onClick={() => go("entries", { filter: "candidates" })}>{tf(pending.more ? "knowledge.pendingMore" : "knowledge.pending", { count: pending.count })}</button> : null}
              {entries.length ? <button type="button" className="see-all-link" onClick={() => go("entries")}>{t("knowledge.showAll")}<ChevronRight aria-hidden="true" /></button> : null}
              {entryCreator(<Button size="sm" variant="ghost"><Plus data-icon="inline-start" />{t("knowledge.create")}</Button>)}
            </div>
          </header>
          {entryRows(searching ? [] : entries.slice(0, OVERVIEW_ENTRIES))}
        </section>
      ) : null}

      {view === "entries" ? (
        <section aria-label={t("knowledge.entriesTitle")} aria-busy={isLoading} className="flex min-w-0 flex-col gap-4">
          <form className="flex flex-wrap gap-2" onSubmit={(event) => {
            event.preventDefault();
            if (!isSaving) void loadEntries({ ...entryPage, q: search.trim(), cursors: [null], nextCursor: null });
          }}>
            <FieldGroup className="flex flex-row flex-wrap items-center gap-2">
              <Field className="min-w-0 flex-1 basis-40"><FieldLabel className="sr-only" htmlFor="knowledge-entry-search">{t("knowledge.searchLabel")}</FieldLabel><ToolbarSearch id="knowledge-entry-search" aria-label={t("knowledge.searchLabel")} maxLength={120}
                placeholder={t("knowledge.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
              <Field className="w-auto"><FieldLabel className="sr-only" htmlFor="knowledge-entry-status">{t("knowledge.viewLabel")}</FieldLabel><SelectField id="knowledge-entry-status" aria-label={t("knowledge.viewLabel")}
                disabled={isLoading || isSaving} value={entryPage.view} onValueChange={(value) => {
                  void loadEntries({ ...entryPage, view: value as KnowledgeView, cursors: [null], nextCursor: null });
                }}>
                <SelectOption value="all">{t("knowledge.view.all")}</SelectOption>
                <SelectOption value="confirmed">{t("knowledge.view.confirmed")}</SelectOption>
                <SelectOption value="candidates">{t("knowledge.view.candidates")}</SelectOption>
              </SelectField></Field>
            </FieldGroup>
          </form>
          {/* Which search the list shows: after a failed search, the box holds the new words while the list still answers the old ones. */}
          {entryPage.q ? <p className="text-xs text-muted-foreground">{t("knowledge.searchApplied")} {entryPage.q}</p> : null}
          {pageNeedsRefresh && !isLoading ? (
            <div role="status" className="page-notice" data-tone="warning">
              <AlertCircle aria-hidden="true" />
              <p>{t("knowledge.refreshRequired")}</p>
            </div>
          ) : null}
          {entryRows(entries, entryPage.q)}
          <nav aria-label={t("knowledge.paginationLabel")} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <Button size="sm" disabled={isLoading || isSaving || pageNeedsRefresh || entryPage.cursors.length === 1} variant="ghost" onClick={() => {
              void loadEntries({ ...entryPage, cursors: entryPage.cursors.slice(0, -1), nextCursor: null });
            }}>{t("knowledge.previousPage")}</Button>
            <span className="text-sm text-muted-foreground" aria-live="polite">{t("knowledge.pagePrefix")} {entryPage.cursors.length} {t("knowledge.pageSuffix")}</span>
            <Button size="sm" disabled={isLoading || isSaving || pageNeedsRefresh || !entryPage.nextCursor} variant="ghost" onClick={() => {
              void loadEntries({ ...entryPage, cursors: [...entryPage.cursors, entryPage.nextCursor], nextCursor: null });
            }}>{t("knowledge.nextPage")}</Button>
          </nav>
        </section>
      ) : null}
    </main>
  );
}
