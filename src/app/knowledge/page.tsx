"use client";

import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { formatDateTime } from "@/lib/locale";

import { FormEvent, useEffect, useRef, useState } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { ArrowLeft, BookOpen, Loader2, PencilLine, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DocumentLibrary } from "@/features/knowledge/document-library";
import { TopicEntry } from "@/features/topics/topic-entry";
import { t } from "@/lib/locale";

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
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entryPage, setEntryPage] = useState<EntryPage>(firstEntryPage);
  const [pageNeedsRefresh, setPageNeedsRefresh] = useState(false);
  const [search, setSearch] = useState("");
  const entryRequest = useRef<AbortController | null>(null);
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
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            href="/chat"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {t("knowledge.backToChat")}
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-headline">
            <BookOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
            {t("knowledge.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("knowledge.description")}</p>
        </div>
        {/* `refreshing` keeps the label and width fixed while the request is in
            flight, so the header does not reflow under the spinner. */}
        <RefreshButton
          disabled={isSaving || (isLoading && entries.length === 0)}
          onClick={() => void loadEntries()}
          refreshing={isLoading}
          variant="outline"
          label={t("knowledge.refresh")}
        />
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("knowledge.error.title")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

        <TopicEntry />
        <DocumentLibrary />
      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{t("knowledge.createTitle")}</CardTitle>
            <CardDescription>{t("knowledge.createDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={onSubmit}>
              <Input onChange={(event) => setKey(event.target.value)} placeholder={t("knowledge.keyPlaceholder")} value={key} />
              <Textarea
                className="min-h-40"
                onChange={(event) => setValue(event.target.value)}
                placeholder={t("knowledge.valuePlaceholder")}
                value={value}
              />
              <Button className="w-full" disabled={isSaving || isLoading} type="submit">
                {isSaving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Plus aria-hidden="true" className="mr-2 h-4 w-4" />}
                {t("knowledge.create")}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card aria-busy={isLoading} className="min-h-[520px] overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>{t("knowledge.entriesTitle")}</CardTitle>
                <CardDescription>{t("knowledge.entriesDescription")}</CardDescription>
              </div>
              <Badge variant="outline">{`${t("knowledge.currentPage")} ${entries.length} ${t("knowledge.entryCountUnit")}`}</Badge>
            </div>
            <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (!isSaving) void loadEntries({ ...entryPage, q: search.trim(), cursors: [null], nextCursor: null });
            }}>
              <Input aria-label={t("knowledge.searchLabel")} className="min-w-0 flex-1 basis-40" maxLength={120}
                placeholder={t("knowledge.searchPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} />
              <select aria-label={t("knowledge.viewLabel")} className="h-9 rounded-md border bg-background px-2 text-sm"
                disabled={isLoading || isSaving} value={entryPage.view} onChange={(event) => {
                  void loadEntries({ ...entryPage, view: event.target.value as KnowledgeView, cursors: [null], nextCursor: null });
                }}>
                <option value="all">{t("knowledge.view.all")}</option>
                <option value="confirmed">{t("knowledge.view.confirmed")}</option>
                <option value="candidates">{t("knowledge.view.candidates")}</option>
              </select>
              <Button disabled={isSaving} type="submit" variant="outline">{t("knowledge.search")}</Button>
            </form>
            {entryPage.q ? <p className="mt-2 text-xs text-muted-foreground">{t("knowledge.searchApplied")} {entryPage.q}</p> : null}
            {pageNeedsRefresh && !isLoading ? <p className="mt-2 text-xs text-warning">{t("knowledge.refreshRequired")}</p> : null}
          </CardHeader>
          <CardContent className="chat-list-scroll max-h-[calc(100vh-15rem)] overflow-y-auto p-4 pr-3">
            {/* The skeleton is a first-load placeholder, not a refresh state.
                A refresh keeps the entries on screen and only spins the button;
                replacing them with placeholders made every refresh read as a
                page reload. */}
            {awaitingFirstEntryLoad ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : entries.length === 0 ? (
              <p className="empty-state !p-4 !text-left">{entryPage.q || entryPage.view !== "all" || entryPage.cursors.length > 1 ? t("knowledge.noMatches") : t("knowledge.empty")}</p>
            ) : (
              <div className="space-y-3">
                {entries.map((entry) => (
                  <article
                    className="rounded-lg bg-background p-4 shadow-hairline transition-shadow duration-200 hover:shadow-card"
                    key={entry.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate text-sm font-semibold tracking-label">{entry.key}</h2>
                          <Badge variant="outline">{t(`knowledge.source.${entry.source}`)}</Badge>
                          {!entry.confirmed ? <Badge variant="warning">{t("knowledge.candidateBadge")}</Badge> : null}
                        </div>
                        {editingId === entry.id ? (
                          <div className="mt-2 space-y-2">
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
                        ) : (
                          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                            {entry.value}
                          </p>
                        )}
                        {!entry.confirmed ? (
                          <p className="mt-2 text-xs text-warning">{t("knowledge.candidateNote")}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!entry.confirmed ? (
                          <Button disabled={isSaving || isLoading} onClick={() => void updateEntry(entry.id, { confirmed: true })} size="sm" type="button" variant="secondary">
                            {t("knowledge.accept")}
                          </Button>
                        ) : null}
                        {editingId !== entry.id ? (
                          <Button
                            aria-label={`${t("knowledge.edit")} ${entry.key}`}
                            disabled={isSaving || isLoading}
                            onClick={() => { setEditingId(entry.id); setEditingValue(entry.value); }}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <PencilLine aria-hidden="true" className="h-4 w-4" />
                          </Button>
                        ) : null}
                        <Button
                          aria-label={`${t("knowledge.deleteLabel")} ${entry.key}`}
                          disabled={isSaving || isLoading}
                          onClick={() => void deleteEntry(entry.id)}
                          size="icon"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <p className="label-mono mt-3">
                      {`${t("knowledge.updatedAt")} ${formatTime(entry.updatedAt)} ${t("knowledge.divider")} ${entry.lastUsedAt ? `${t("knowledge.lastUsed")} ${formatTime(entry.lastUsedAt)}` : t("knowledge.neverUsed")}`}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </CardContent>
          <nav aria-label={t("knowledge.paginationLabel")} className="flex flex-wrap items-center justify-between gap-2 border-t p-4">
            <Button disabled={isLoading || isSaving || pageNeedsRefresh || entryPage.cursors.length === 1} variant="outline" onClick={() => {
              void loadEntries({ ...entryPage, cursors: entryPage.cursors.slice(0, -1), nextCursor: null });
            }}>{t("knowledge.previousPage")}</Button>
            <span className="text-sm text-muted-foreground" aria-live="polite">{t("knowledge.pagePrefix")} {entryPage.cursors.length} {t("knowledge.pageSuffix")}</span>
            <Button disabled={isLoading || isSaving || pageNeedsRefresh || !entryPage.nextCursor} variant="outline" onClick={() => {
              void loadEntries({ ...entryPage, cursors: [...entryPage.cursors, entryPage.nextCursor], nextCursor: null });
            }}>{t("knowledge.nextPage")}</Button>
          </nav>
        </Card>
      </div>
    </main>
  );
}
