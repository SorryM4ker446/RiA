"use client";
import { useLocale } from "@/lib/locale/client";

import { formatDateTime, t, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { FormEvent, useEffect, useRef, useState } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { ArrowLeft, BookOpen, Loader2, PencilLine, Plus, Search, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DocumentLibrary } from "@/features/knowledge/document-library";
import { TopicEntry } from "@/features/topics/topic-entry";
import { KnowledgeEntryContent } from "@/features/knowledge/entry-content";
import { presentToolMemory } from "@/features/knowledge/entry-presentation";
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

export default function KnowledgePage() {
  useLocale();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entryPage, setEntryPage] = useState<EntryPage>(firstEntryPage);
  const [pageNeedsRefresh, setPageNeedsRefresh] = useState(false);
  const [search, setSearch] = useState("");
  const entryRequest = useRef<AbortController | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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
    } catch (updateError) {
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
      setEntries((current) => current.filter((entry) => entry.id !== entryId));
      if (editingId === entryId) setEditingId(null);
      setPageNeedsRefresh(true);
      await loadEntries({ ...entryPage, cursors: [null], nextCursor: null });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("knowledge.error.delete"));
    } finally {
      setIsSaving(false);
    }
  }

  useEffect(() => {
    void loadEntries(firstEntryPage);
    void loadPersona();
    return () => entryRequest.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load on mount
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
      <header className="workspace-page-header">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-headline">
            <BookOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
            {t("knowledge.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("knowledge.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2"><TopicEntry /><Button variant="ghost" size="sm" asChild><Link href="/chat"><ArrowLeft data-icon="inline-start" />{t("knowledge.backToChat")}</Link></Button></div>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("knowledge.error.title")}</AlertTitle>
          <AlertDescription>{localizeMessage(error)}</AlertDescription>
        </Alert>
      ) : null}

      <DocumentLibrary />
      <section aria-label={t("knowledge.entriesTitle")} aria-busy={isLoading} className="flex min-w-0 flex-col gap-4 pt-3">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{t("knowledge.entriesTitle")}</h2><Badge variant="secondary">{`${t("knowledge.currentPage")} ${entries.length} ${t("knowledge.entryCountUnit")}`}</Badge></div>
          <div className="flex items-center gap-1">
            <RefreshButton disabled={isSaving || (isLoading && entries.length === 0)} onClick={() => void loadEntries()} refreshing={isLoading} variant="ghost" size="sm" label={t("knowledge.refresh")} />
            <Sheet open={createOpen} onOpenChange={open => { if (!isSaving) { setCreateOpen(open); if (open) setError(null); } }}>
              <SheetTrigger asChild><Button size="sm"><Plus data-icon="inline-start" />{t("knowledge.create")}</Button></SheetTrigger>
              <SheetContent side="right" className="knowledge-entry-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel={t("ui.knowledge.closeNewKnowledgeEntry")}>
                <header className="flex flex-col gap-2 pr-8"><SheetTitle>{t("knowledge.createTitle")}</SheetTitle><SheetDescription>{t("knowledge.createDescription")}</SheetDescription></header>
                <form className="flex min-h-0 flex-1 flex-col gap-5" onSubmit={onSubmit}>
                  <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                    {error && <Alert variant="destructive"><AlertTitle>{t("knowledge.error.title")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert>}
                    <FieldGroup><Field><FieldLabel htmlFor="knowledge-entry-key">{t("knowledge.keyPlaceholder")}</FieldLabel><Input id="knowledge-entry-key" disabled={isSaving} onChange={event => setKey(event.target.value)} placeholder={t("knowledge.keyPlaceholder")} value={key} /></Field><Field><FieldLabel htmlFor="knowledge-entry-value">{t("knowledge.valuePlaceholder")}</FieldLabel><Textarea id="knowledge-entry-value" disabled={isSaving} rows={8} onChange={event => setValue(event.target.value)} placeholder={t("knowledge.valuePlaceholder")} value={value} /></Field></FieldGroup>
                  </div>
                  <footer className="flex shrink-0 justify-end gap-2"><Button type="button" variant="ghost" disabled={isSaving} onClick={() => setCreateOpen(false)}>{t("knowledge.cancelEdit")}</Button><Button disabled={isSaving || isLoading} type="submit">{isSaving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}{t("knowledge.create")}</Button></footer>
                </form>
              </SheetContent>
            </Sheet>
          </div>
        </header>
            <form className="flex flex-wrap gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (!isSaving) void loadEntries({ ...entryPage, q: search.trim(), cursors: [null], nextCursor: null });
            }}>
              <FieldGroup className="flex flex-row flex-wrap items-center gap-2">
              <Field className="min-w-0 flex-1 basis-40"><FieldLabel className="sr-only" htmlFor="knowledge-entry-search">{t("knowledge.searchLabel")}</FieldLabel><Input id="knowledge-entry-search" aria-label={t("knowledge.searchLabel")} maxLength={120}
                placeholder={t("knowledge.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
              <Field className="w-auto"><FieldLabel className="sr-only" htmlFor="knowledge-entry-status">{t("knowledge.viewLabel")}</FieldLabel><SelectField id="knowledge-entry-status" aria-label={t("knowledge.viewLabel")}
                disabled={isLoading || isSaving} value={entryPage.view} onValueChange={(value) => {
                  void loadEntries({ ...entryPage, view: value as KnowledgeView, cursors: [null], nextCursor: null });
                }}>
                <SelectOption value="all">{t("knowledge.view.all")}</SelectOption>
                <SelectOption value="confirmed">{t("knowledge.view.confirmed")}</SelectOption>
                <SelectOption value="candidates">{t("knowledge.view.candidates")}</SelectOption>
              </SelectField></Field>
              <Button disabled={isSaving} type="submit" variant="secondary"><Search data-icon="inline-start" />{t("knowledge.search")}</Button>
              </FieldGroup>
            </form>
            {entryPage.q ? <p className="mt-2 text-xs text-muted-foreground">{t("knowledge.searchApplied")} {entryPage.q}</p> : null}
            {pageNeedsRefresh && !isLoading ? <p className="mt-2 text-xs text-warning">{t("knowledge.refreshRequired")}</p> : null}
          <div className="chat-list-scroll min-w-0 max-h-[36rem] overflow-y-auto">
            {/* The skeleton is a first-load placeholder, not a refresh state.
                A refresh keeps the entries on screen and only spins the button;
                replacing them with placeholders made every refresh read as a
                page reload. */}
            {awaitingFirstEntryLoad ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : entries.length === 0 ? (
              <Empty className="py-6"><EmptyHeader><EmptyMedia><BookOpen /></EmptyMedia><EmptyTitle>{entryPage.q || entryPage.view !== "all" || entryPage.cursors.length > 1 ? t("knowledge.noMatches") : t("knowledge.empty")}</EmptyTitle><EmptyDescription>{t("ui.knowledge.addReusableInformationOrConfirmKnowledge")}</EmptyDescription></EmptyHeader></Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {entries.map((entry) => {
                  const toolMemory = presentToolMemory(entry.key, entry.value);
                  const title = toolMemory?.title ?? entry.key;
                  const actionLabel = toolMemory ? `${toolMemory.toolLabel} · ${title}` : title;
                  return (
                  <article
                    className="management-row knowledge-entry-row flex min-w-0 flex-col gap-3 rounded-xl p-4"
                    key={entry.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{title}</h3>
                          <Badge variant="outline">{toolMemory?.toolLabel ?? t(`knowledge.source.${entry.source}`)}</Badge>
                          {!entry.confirmed ? <Badge variant="warning">{t("knowledge.candidateBadge")}</Badge> : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!entry.confirmed ? (
                          <Button disabled={isSaving || isLoading} onClick={() => void updateEntry(entry.id, { confirmed: true })} size="sm" type="button" variant="secondary">
                            {t("knowledge.accept")}
                          </Button>
                        ) : null}
                        {editingId !== entry.id ? (
                          <Button
                            aria-label={`${t("knowledge.edit")} ${actionLabel}`} title={t("knowledge.edit")}
                            disabled={isSaving || isLoading}
                            onClick={() => { setEditingId(entry.id); setEditingValue(entry.value); }}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <PencilLine aria-hidden="true" className="h-4 w-4" />
                          </Button>
                        ) : null}
                        <Button
                          aria-label={`${t("knowledge.deleteLabel")} ${actionLabel}`} title={t("documents.delete")}
                          disabled={isSaving || isLoading}
                          onClick={() => void deleteEntry(entry.id)}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                        {editingId === entry.id ? (
                          <div className="mt-2 flex flex-col gap-2">
                            <Textarea
                              aria-label={t("knowledge.editValueLabel")}
                              onChange={(event) => setEditingValue(event.target.value)}
                              rows={3}
                              value={editingValue}
                            />
                            <div className="flex gap-2">
                              <Button
                                disabled={isSaving || isLoading}
                                onClick={() => void updateEntry(entry.id, { value: editingValue })}
                                size="sm"
                                type="button"
                              >
                                {t("knowledge.saveEdit")}
                              </Button>
                              <Button disabled={isSaving} onClick={() => setEditingId(null)} size="sm" type="button" variant="ghost">
                                {t("knowledge.cancelEdit")}
                              </Button>
                            </div>
                          </div>
                        ) : <KnowledgeEntryContent entryKey={entry.key} value={entry.value} toolMemory={toolMemory} />}
                        {!entry.confirmed ? (
                          <p className="mt-2 text-xs text-warning">{t("knowledge.candidateNote")}</p>
                        ) : null}
                    <p className="break-words text-xs leading-5 text-muted-foreground">
                      {`${t("knowledge.updatedAt")} ${formatTime(entry.updatedAt)} ${t("knowledge.divider")} ${entry.lastUsedAt ? `${t("knowledge.lastUsed")} ${formatTime(entry.lastUsedAt)}` : t("knowledge.neverUsed")}`}
                    </p>
                  </article>
                ); })}
              </div>
            )}
          </div>
          <nav aria-label={t("knowledge.paginationLabel")} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <Button disabled={isLoading || isSaving || pageNeedsRefresh || entryPage.cursors.length === 1} variant="outline" onClick={() => {
              void loadEntries({ ...entryPage, cursors: entryPage.cursors.slice(0, -1), nextCursor: null });
            }}>{t("knowledge.previousPage")}</Button>
            <span className="text-sm text-muted-foreground" aria-live="polite">{t("knowledge.pagePrefix")} {entryPage.cursors.length} {t("knowledge.pageSuffix")}</span>
            <Button disabled={isLoading || isSaving || pageNeedsRefresh || !entryPage.nextCursor} variant="outline" onClick={() => {
              void loadEntries({ ...entryPage, cursors: [...entryPage.cursors, entryPage.nextCursor], nextCursor: null });
            }}>{t("knowledge.nextPage")}</Button>
          </nav>
      </section>
    </main>
  );
}
