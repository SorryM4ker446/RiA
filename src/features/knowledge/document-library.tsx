"use client";

import { Loader2, Upload } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { DOCUMENT_LIMITS, type DocumentSource } from "@/lib/documents/types";
import { t, tf } from "@/lib/locale";

type DocumentSummary = { id: string; filename: string; characterCount: number; indexedAt: string; _count: { chunks: number } };

export async function documentRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, t("documents.requestFailed")));
  return payload.data as T;
}

export function DocumentLibrary() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const awaitingFirstDocumentLoad = useAwaitingFirstLoad(loading, "documents");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentSource[] | null>(null);
  async function refresh() { setDocuments(await documentRequest<DocumentSummary[]>("/api/documents")); }
  useEffect(() => {
    const controller = new AbortController();
    documentRequest<DocumentSummary[]>("/api/documents", { signal: controller.signal }).then(setDocuments).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function run(operation: () => Promise<void>, options?: { keepNotice?: boolean }) {
    setBusy(true); setError("");
    if (!options?.keepNotice) setNotice("");
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : t("documents.actionFailed")); }
    finally { setBusy(false); }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || !file.size) { setError(t("documents.selectFirst")); return; }
    if (file.size > DOCUMENT_LIMITS.fileBytes) { setError(t("documents.tooLarge")); return; }
    await run(async () => {
      setImporting(true);
      const result = await documentRequest<{ change: string; added: number; retained: number; removed: number }>("/api/documents", { method: "POST", body: data });
      form.reset(); setResults(null);
      await refresh();
      // The `change` value is the API's own enum and is compared as-is.
      setNotice(result.change === "unchanged" ? t("documents.unchanged") : tf("documents.savedSummary", { added: result.added, retained: result.retained, removed: result.removed }));
    });
    setImporting(false);
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    await run(async () => setResults(await documentRequest<DocumentSource[]>("/api/documents/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) })));
  }

  return <Card>
    <CardHeader>
      <CardTitle>{t("documents.libraryTitle")}</CardTitle>
      <CardDescription>{t("documents.libraryDescription")}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">{t("documents.textOnlyNote")}</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => void upload(event)}>
        {/* A div, not a label: FileInput renders its own label for the trigger,
            and nesting the two makes the association ambiguous. The input keeps
            the accessible name the tests address it by. */}
        <div className="min-w-0 flex-1 space-y-1.5 text-sm">
          <span>{t("documents.fileLabel")}</span>
          <FileInput
            accept=".pdf,.md,.txt,.docx"
            aria-label={t("documents.fileLabel")}
            buttonLabel={t("documents.fileButton")}
            disabled={busy}
            name="file"
            required
          />
        </div>
        {/* The label never changes: swapping in a longer "importing" sentence
            resized the button and shoved the picker on every refresh, because
            `busy` is set by refreshing too. The icon carries the state instead. */}
        <Button disabled={busy} type="submit">
          {importing
            ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
            : <Upload aria-hidden="true" className="mr-2 h-4 w-4" />}
          {t("documents.import")}
        </Button>
      </form>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-label">{t("documents.importedTitle")}{t("documents.countOpen")}{documents.length}{t("documents.countClose")}</h2>
        <RefreshButton disabled={busy} onClick={() => void run(refresh, { keepNotice: true })} refreshing={busy} size="sm" label={t("documents.refresh")} variant="secondary" />
      </div>
      {/* A refresh keeps the list on screen. Only a first load with nothing to
          show falls back to a line of text, so re-reading the list never
          replaces the documents with a "loading" sentence. */}
      {awaitingFirstDocumentLoad ? <p className="text-sm text-muted-foreground">{t("documents.loading")}</p> : !documents.length ? <p className="text-sm text-muted-foreground">{t("documents.empty")}</p> : <ul className="chat-list-scroll max-h-96 space-y-2 overflow-y-auto">
        {documents.map(document => <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background p-3 shadow-hairline" key={document.id}>
          <div className="min-w-0">
            <Link className="break-all text-sm font-medium tracking-label underline underline-offset-4 hover:no-underline" href={`/knowledge/documents/${document.id}`}>{document.filename}</Link>
            <p className="mt-1 text-xs text-muted-foreground">{document._count.chunks} {t("documents.chunkUnit")} · {document.characterCount.toLocaleString()} {t("documents.characterUnit")} · {t("documents.indexedAt")} {new Date(document.indexedAt).toLocaleString(t("documents.dateLocale"))}</p>
          </div>
          <div className="flex gap-1">
            <Button aria-label={`${t("documents.reindex")} ${document.filename}`} disabled={busy} size="sm" variant="secondary" onClick={() => void run(async () => {
              await documentRequest(`/api/documents/${document.id}`, { method: "POST" }); await refresh(); setResults(null); setNotice(t("documents.reindexed"));
            })}>{t("documents.reindex")}</Button>
            <Button aria-label={`${t("documents.deleteLabel")} ${document.filename}`} disabled={busy} size="sm" variant="ghost" onClick={() => {
              if (window.confirm(`${t("documents.deleteConfirmPrefix")}${document.filename}${t("documents.deleteConfirmSuffix")}`)) void run(async () => {
                await documentRequest(`/api/documents/${document.id}`, { method: "DELETE" }); await refresh(); setResults(null); setNotice(t("documents.deleted"));
              });
            }}>{t("documents.delete")}</Button>
          </div>
        </li>)}
      </ul>}
      <form className="flex flex-wrap gap-2 border-t pt-4" onSubmit={event => void search(event)}>
        <Input aria-label={t("documents.searchLabel")} className="min-w-0 flex-1" disabled={busy} maxLength={2000} onChange={event => setQuery(event.target.value)} placeholder={t("documents.searchPlaceholder")} required value={query} />
        <Button disabled={busy || !query.trim()} type="submit" variant="secondary">{t("documents.search")}</Button>
      </form>
      {results?.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t("documents.noMatches")}</p> : null}
      <DocumentSources sources={results ?? []} />
    </CardContent>
  </Card>;
}
