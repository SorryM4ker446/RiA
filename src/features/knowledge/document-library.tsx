"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatNumber, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { ChevronRight, FileText, Info, Loader2, RotateCw, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { RetrievalEvaluation } from "./retrieval-evaluation";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { DOCUMENT_LIMITS, type DocumentSource } from "@/lib/documents/types";
import { documentRequest, type DocumentSummary, type DocumentPreview } from "./document-client";
import { maintainDocumentIndexes, type IndexProgress } from "./index-maintenance";
import { IndexStatus } from "./index-status";
export { documentRequest } from "./document-client";

export function DocumentLibrary() {
  useLocale();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const awaitingFirstDocumentLoad = useAwaitingFirstLoad(loading, "documents");
  const [busy, setBusy] = useState(false);
  const [collection, setCollection] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searchCollection, setSearchCollection] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentSource[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const operation = useRef<AbortController | null>(null);
  const initialRequest = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const previewData = useRef<FormData | null>(null);
  const [progress, setProgress] = useState<IndexProgress[]>([]);
  async function refresh(signal?: AbortSignal) {
    const updated = await documentRequest<DocumentSummary[]>("/api/documents", { signal });
    if (!signal?.aborted) setDocuments(updated);
  }
  useEffect(() => {
    const controller = new AbortController();
    initialRequest.current = controller;
    documentRequest<DocumentSummary[]>("/api/documents", { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setDocuments(value); }).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); operation.current?.abort(); operation.current = null; };
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>, options?: { keepNotice?: boolean }) {
    if (operation.current) return;
    initialRequest.current?.abort(); setLoading(false);
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); if (!options?.keepNotice) setNotice("");
    try { await action(controller.signal); }
    catch (error) { if (operation.current === controller) { if (controller.signal.aborted) setNotice(t("ui.knowledge.document-library.operationCancelledSavedBatchesArePreserved")); else setError(error instanceof Error ? error.message : t("documents.actionFailed")); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const file = data.get("file");
    if (!(file instanceof File) || !file.size) { setError(t("documents.selectFirst")); return; }
    if (collection.trim()) data.set("collection", collection.trim());
    if (file.size > DOCUMENT_LIMITS.fileBytes) { setError(t("documents.tooLarge")); return; }
    setPreview(null); previewData.current = null;
    await run(async signal => {
      setImporting(true);
      try {
        const value = await documentRequest<DocumentPreview>("/api/documents/preview", { method: "POST", body: data, signal });
        if (!signal.aborted) { setPreview(value); previewData.current = data; }
      } finally { setImporting(false); }
    });
  }
  async function savePreview() {
    if (!preview || !previewData.current) return;
    const data = previewData.current; data.set("previewHash", preview.previewHash); data.set("base", JSON.stringify(preview.base));
    await run(async signal => {
      const result = await documentRequest<{ change: string; added: number; retained: number; removed: number }>("/api/documents", { method: "POST", body: data, signal });
      if (signal.aborted) return;
      setPreview(null); previewData.current = null; setResults(null); setDiagnostics(null);
      setNotice(result.change === "unchanged" ? t("documents.unchanged") : tf("documents.savedSummary", { added: result.added, retained: result.retained, removed: result.removed }));
      try { await refresh(signal); } catch { if (!signal.aborted) setError(t("ui.knowledge.document-library.documentSavedButRefreshingTheList")); }
    });
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    setResults(null); setDiagnostics(null);
    await run(async signal => {
      const response = await fetch("/api/documents/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, collections: searchCollection ? [searchCollection] : [] }), signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("documents.requestFailed")));
      setResults(payload.data); setDiagnostics(payload.diagnostics);
    });
  }

  async function buildSemanticIndexes(targets: DocumentSummary[]) {
    if (operation.current || !targets.length) return;
    const models = [...new Set(targets.flatMap(document => document.semantic?.modelRef ? [document.semantic.modelRef.modelId] : []))];
    if (!models.length || !window.confirm(tf("ui.knowledge.document-library.sendPendingChunksFromDocumentsTo", { v0: targets.length, v1: models.join("、") }))) return;
    await run(async signal => {
      const items = await maintainDocumentIndexes(targets, signal, items => { if (!signal.aborted || operation.current?.signal === signal) setProgress(items); });
      if (!signal.aborted) {
        const failure = items.find(item => item.status === "failed");
        if (failure) setError(failure.error ?? t("ui.knowledge.document-library.indexingFailedCompletedBatchesArePreserved"));
        setNotice(tf("ui.knowledge.document-library.indexingDocumentsCompleteUnfinishedItemsCan", { v0: items.filter(item => item.status === "complete").length, v1: items.length }));
        try { await refresh(signal); } catch { if (!signal.aborted) setError(t("ui.knowledge.document-library.indexBatchesFinishedButStatusRefresh")); }
        setResults(null); setDiagnostics(null);
      } else if (operation.current?.signal === signal) setNotice(t("ui.knowledge.document-library.indexingCancelledCompletedBatchesArePreserved"));
    });
  }

  return <section aria-label={t("documents.libraryTitle")} className="flex min-w-0 flex-col gap-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><h2 className="text-base font-semibold">{t("documents.libraryTitle")}</h2><Badge variant="secondary">{documents.length} {t("ui.knowledge.document-library.documents")}</Badge></div>
      <RefreshButton disabled={busy} onClick={() => void run(refresh, { keepNotice: true })} refreshing={busy} size="sm" label={t("documents.refresh")} variant="ghost" />
    </header>
    <form onSubmit={event => void upload(event)} aria-label={t("ui.knowledge.document-library.importKnowledgeDocuments")}>
      <FieldGroup className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
        <Field className="min-w-0 gap-2"><FieldLabel className="text-xs" htmlFor="knowledge-document-file">{t("documents.fileLabel")}</FieldLabel><FileInput id="knowledge-document-file" accept=".pdf,.md,.txt,.docx" aria-label={t("documents.fileLabel")} buttonLabel={t("documents.fileButton")} placeholder="PDF、Word、Markdown、TXT" disabled={busy} name="file" onChange={() => { setPreview(null); previewData.current = null; }} required /></Field>
        <Field className="min-w-0 gap-2"><FieldLabel className="text-xs" htmlFor="knowledge-document-collection">{t("documents.collectionLabel")}</FieldLabel><Input id="knowledge-document-collection" aria-label={t("documents.collectionLabel")} disabled={busy} list="document-collections" name="collection" onChange={event => { setCollection(event.target.value); setPreview(null); previewData.current = null; }} placeholder={t("documents.collectionPlaceholder")} value={collection} /><datalist id="document-collections">{[...new Set(documents.map(document => document.collection).filter((value): value is string => Boolean(value)))].map(value => <option key={value} value={value} />)}</datalist></Field>
        <Button disabled={busy} type="submit">{importing ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Upload data-icon="inline-start" />}{t("documents.import")}</Button>
      </FieldGroup>
    </form>
    <details className="settings-disclosure knowledge-disclosure group"><summary className="settings-disclosure-trigger py-1 text-xs text-muted-foreground"><Info className="size-3.5" aria-hidden="true" />{t("ui.knowledge.document-library.importPrivacyInformation")}<ChevronRight className="size-3 transition-transform duration-[--dur-fast] group-open:rotate-90" aria-hidden="true" /></summary><div className="flex max-w-3xl flex-col gap-2 py-3 text-xs leading-6 text-muted-foreground"><p>{t("documents.libraryDescription")}</p><p>{t("documents.textOnlyNote")}</p><p>{t("ui.knowledge.document-library.importShowsAnExtractionPreviewFirst")}</p></div></details>
    {error ? <Alert variant="destructive"><AlertTitle>{t("ui.knowledge.document-library.documentOperationIncomplete")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}
    {notice ? <p role="status" className="text-sm leading-6 text-muted-foreground">{localizeMessage(notice)}</p> : null}
    {preview ? <section className="knowledge-preview flex flex-col gap-3 rounded-xl bg-muted/40 p-4" aria-label={t("ui.knowledge.document-library.documentImportPreview")}>
      <h3 className="break-words text-sm font-medium">{t("ui.knowledge.document-library.preview")}{preview.filename} · {preview.chunks.length} {t("ui.knowledge.document-library.chunks")}{preview.characterCount} {t("documents.characterUnit")}</h3>
      {preview.notes.map(note => <p className="text-xs leading-6 text-muted-foreground" key={note}>{note}</p>)}
      {preview.base ? <p className="text-xs leading-6">{t("ui.knowledge.document-library.confirmingUpdatesTheDocumentWithThe")}</p> : null}
      <div className="chat-list-scroll flex max-h-64 flex-col gap-3 overflow-y-auto">{preview.chunks.map(chunk => <div key={chunk.ordinal} className="flex flex-col gap-1"><p className="text-xs text-muted-foreground">{t("documents.chunkLabel")}{chunk.ordinal + 1}{chunk.heading ? ` · ${chunk.heading}` : ""}{chunk.pageNumber ? tf("ui.knowledge.document-library.page", { v0: chunk.pageNumber }) : ""}</p><pre className="whitespace-pre-wrap break-words text-xs leading-6 [overflow-wrap:anywhere]">{chunk.text}</pre></div>)}</div>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void savePreview()}>{t("ui.knowledge.document-library.confirmDocumentSave")}</Button><Button size="sm" disabled={busy} variant="ghost" onClick={() => { setPreview(null); previewData.current = null; }}>{t("ui.knowledge.document-library.discardPreview")}</Button></div>
    </section> : null}
    <form aria-label={t("ui.knowledge.document-library.searchDocumentKnowledge")} onSubmit={event => void search(event)}>
      <FieldGroup className="flex flex-row flex-wrap items-center gap-2">
        <Field className="w-auto"><FieldLabel className="sr-only" htmlFor="knowledge-document-scope">{t("ui.knowledge.document-library.searchKnowledgeCollections")}</FieldLabel><SelectField id="knowledge-document-scope" aria-label={t("ui.knowledge.document-library.searchKnowledgeCollections")} disabled={busy} value={searchCollection} onValueChange={value => { setSearchCollection(value); setResults(null); }}><SelectOption value="">{t("ui.knowledge.document-library.allCollections")}</SelectOption>{[...new Set([...documents.flatMap(document => document.collection ? [document.collection] : []), ...(searchCollection ? [searchCollection] : [])])].sort().map(name => <SelectOption key={name} value={name}>{name}{documents.some(document => document.collection === name) ? "" : t("ui.knowledge.document-library.noKnowledgeYet")}</SelectOption>)}</SelectField></Field>
        <Field className="min-w-0 flex-1 basis-48"><FieldLabel htmlFor="knowledge-document-query" className="sr-only">{t("documents.searchLabel")}</FieldLabel><Input id="knowledge-document-query" aria-label={t("documents.searchLabel")} disabled={busy} maxLength={2000} onChange={event => setQuery(event.target.value)} placeholder={t("documents.searchPlaceholder")} required value={query} /></Field>
        <Button disabled={busy || !query.trim()} type="submit" variant="secondary"><Search data-icon="inline-start" />{t("documents.search")}</Button>
      </FieldGroup>
    </form>
    {results?.length === 0 ? <p role="status" className="text-sm leading-6 text-muted-foreground">{t("documents.noMatches")}</p> : null}
    <DocumentSources sources={results ?? []} />
    {results !== null ? <RetrievalDiagnostics value={diagnostics} /> : null}
    {awaitingFirstDocumentLoad ? <div className="flex flex-col gap-2" aria-label={t("documents.loading")}><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div> : !documents.length ? <Empty className="py-6"><EmptyHeader><EmptyMedia><FileText /></EmptyMedia><EmptyTitle>{t("documents.empty")}</EmptyTitle><EmptyDescription>{t("ui.knowledge.document-library.importKnowledgeToSearchItHere")}</EmptyDescription></EmptyHeader></Empty> : <ul aria-label={t("documents.importedTitle")} className="chat-list-scroll flex max-h-80 flex-col gap-1 overflow-y-auto">
      {documents.map(document => <li className="management-row knowledge-document-row flex min-w-0 items-center gap-3 rounded-xl px-3 py-3" key={document.id}>
        <FileText className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2"><Link className="min-w-0 break-words text-sm font-medium hover:underline underline-offset-4 [overflow-wrap:anywhere]" href={`/knowledge/documents/${document.id}`}>{document.filename}</Link>{document.collection && <Badge variant="outline" className="min-w-0"><span className="truncate">{document.collection}</span></Badge>}{document.semantic?.lexicalCurrent === false && <Badge variant="warning">{t("ui.knowledge.document-library.localIndexNeedsUpdating")}</Badge>}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{document._count.chunks} {t("documents.chunkUnit")} · {formatNumber(document.characterCount)} {t("documents.characterUnit")}</span><time dateTime={document.indexedAt}>{new Date(document.indexedAt).toLocaleString(t("documents.dateLocale"))}</time><span title={document.semantic?.modelRef?.modelId}>{document.semantic?.modelRef ? tf("ui.knowledge.document-library.semanticIndex", { v0: document.semantic.indexed, v1: document.semantic.total }) : t("ui.knowledge.document-library.keywordSearch")}</span></div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button title={t("ui.knowledge.document-library.buildSemanticIndex")} aria-label={tf("ui.knowledge.document-library.buildSemanticIndexFor", { v0: document.filename })} disabled={busy || !document.semantic?.modelRef} size="icon-sm" variant="ghost" onClick={() => void buildSemanticIndexes([document])}><Sparkles /></Button>
          <Button title={t("documents.reindex")} aria-label={`${t("documents.reindex")} ${document.filename}`} disabled={busy} size="icon-sm" variant="ghost" onClick={() => void run(async () => { await documentRequest(`/api/documents/${document.id}`, { method: "POST" }); await refresh(); setResults(null); setNotice(t("documents.reindexed")); })}><RotateCw /></Button>
          <Button title={t("documents.delete")} aria-label={`${t("documents.deleteLabel")} ${document.filename}`} disabled={busy} size="icon-sm" variant="ghost" onClick={() => { if (window.confirm(`${t("documents.deleteConfirmPrefix")}${document.filename}${t("documents.deleteConfirmSuffix")}`)) void run(async () => { await documentRequest(`/api/documents/${document.id}`, { method: "DELETE" }); await refresh(); setResults(null); setNotice(t("documents.deleted")); }); }}><Trash2 /></Button>
        </div>
      </li>)}
    </ul>}
    <IndexStatus documents={documents} progress={progress} busy={busy} start={() => void buildSemanticIndexes(documents.filter(document => document.semantic?.modelRef && document.semantic.indexed < document.semantic.total))} cancel={() => operation.current?.abort()} />
    <RetrievalEvaluation />
  </section>;
}
