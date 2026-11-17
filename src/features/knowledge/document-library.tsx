"use client";
import { useLocale } from "@/lib/locale/client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

import { formatList, t, tf, formatNumber, formatRelativeTime, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { ScanText, ChevronRight, FileText, FolderOpen, Info, MoreHorizontal, RotateCw, Trash2, Upload } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Reveal } from "@/components/ui/reveal";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { ToolbarSearch } from "@/components/layout/page-toolbar";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalEvaluation } from "./retrieval-evaluation";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { DOCUMENT_LIMITS, type DocumentSource } from "@/lib/documents/types";
import { documentRequest, listDocuments, searchDocumentContent, type DocumentIndexing, type DocumentSummary, type DocumentPreview } from "./document-client";
import { maintainDocumentIndexes, type IndexProgress } from "./index-maintenance";
import { IndexStatus } from "./index-status";
import { batchItems, DOCUMENT_EXTENSIONS, importBatch, isDocumentFile, type BatchItem, type BatchStatus } from "./document-batch";
import { documentReadiness } from "./document-status";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { useConfirm } from "@/components/ui/confirm-dialog";
export { documentRequest } from "./document-client";

/** How many documents the knowledge overview lists before "All" leads to the full view. */
export const OVERVIEW_DOCUMENTS = 5;

/**
 * The imported documents. In the overview it is a short list of the latest few with a way to all of them;
 * in its own view it is the whole library with topic filter, content search and index upkeep. Importing
 * opens as a card at the top of the list from the page's own action, and folds away once a document is saved.
 */
export function DocumentLibrary({ mode, importOpen, onImportClose, onShowAll, hidden = false }: {
  mode: "overview" | "full";
  importOpen: boolean;
  onImportClose: () => void;
  onShowAll: () => void;
  hidden?: boolean;
}) {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const awaitingFirstDocumentLoad = useAwaitingFirstLoad(loading, "documents");
  const [busy, setBusy] = useState(false);
  const [collection, setCollection] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [searchCollection, setSearchCollection] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentSource[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const operation = useRef<AbortController | null>(null);
  const initialRequest = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const previewData = useRef<FormData | null>(null);
  // What was chosen to import: from the picker, a folder, or files dropped on the card. One file is previewed; several are imported as a batch.
  const [selected, setSelected] = useState<File[]>([]);
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<IndexProgress[]>([]);
  const [automaticIndexing, setAutomaticIndexing] = useState<DocumentIndexing>({ running: false, failed: null });
  // Watches the automatic indexing only while it is running, and stops with this page.
  // Scanned pages being read are watched the same way, so the row counts the pages as they are read.
  const indexingRunning = automaticIndexing.running || documents.some(document => document.ocr && document.ocr.status !== "done" && document.ocr.status !== "failed");
  useEffect(() => {
    if (!indexingRunning) return;
    const timer = setInterval(() => { void listDocuments().then(({ documents: next, indexing }) => { setDocuments(next); setAutomaticIndexing(indexing); }).catch(() => {}); }, 3_000);
    return () => clearInterval(timer);
  }, [indexingRunning]);
  async function refresh(signal?: AbortSignal) {
    const { documents: updated, indexing } = await listDocuments(signal);
    if (!signal?.aborted) { setDocuments(updated); setAutomaticIndexing(indexing); }
  }
  useEffect(() => {
    const controller = new AbortController();
    initialRequest.current = controller;
    listDocuments(controller.signal).then(({ documents: value, indexing }) => { if (!controller.signal.aborted) { setDocuments(value); setAutomaticIndexing(indexing); } }).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); operation.current?.abort(); operation.current = null; };
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    initialRequest.current?.abort(); setLoading(false);
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError("");
    try { await action(controller.signal); }
    catch (error) { if (operation.current === controller) { if (controller.signal.aborted) toast(t("ui.knowledge.document-library.operationCancelledSavedBatchesArePreserved")); else setError(error instanceof Error ? error.message : t("documents.actionFailed")); } }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  function choose(files: File[]) {
    setSelected(files); setBatch(null); setPreview(null); previewData.current = null; setError("");
  }
  async function importAll(items: BatchItem[]) {
    setPreview(null); previewData.current = null; setBatch(items);
    await run(async signal => {
      setImporting(true);
      try {
        const done = await importBatch(items, collection, signal, setBatch, t("documents.requestFailed"));
        if (signal.aborted) { toast(t("documents.batch.stopped")); return; }
        const count = (status: BatchStatus) => done.filter(item => item.status === status).length;
        toast(tf("documents.batch.summary", { added: count("added"), updated: count("updated"), unchanged: count("unchanged"), failed: count("failed"), skipped: count("skipped") }));
        setResults(null); setDiagnostics(null);
        try { await refresh(signal); } catch { if (!signal.aborted) setError(t("ui.knowledge.document-library.documentSavedButRefreshingTheList")); }
      } finally { setImporting(false); }
    });
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected.length > 1) { await importAll(batchItems(selected, { unsupported: t("documents.batch.unsupported"), tooLarge: t("documents.tooLarge") })); return; }
    const file = selected[0];
    if (!file || !file.size) { setError(t("documents.selectFirst")); return; }
    const data = new FormData(); data.set("file", file, file.name);
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
      setPreview(null); previewData.current = null; setResults(null); setDiagnostics(null); setCollection(""); onImportClose();
      toast(result.change === "unchanged" ? t("documents.unchanged") : tf("documents.savedSummary", { added: result.added, retained: result.retained, removed: result.removed }));
      try { await refresh(signal); } catch { if (!signal.aborted) setError(t("ui.knowledge.document-library.documentSavedButRefreshingTheList")); }
    });
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    setResults(null); setDiagnostics(null);
    await run(async signal => {
      const found = await searchDocumentContent(query, searchCollection ? [searchCollection] : [], signal);
      setResults(found.sources); setDiagnostics(found.diagnostics);
    });
  }

  async function buildSemanticIndexes(targets: DocumentSummary[]) {
    if (operation.current || !targets.length) return;
    const models = [...new Set(targets.flatMap(document => document.semantic?.modelRef ? [document.semantic.modelRef.modelId] : []))];
    if (!models.length || !(await confirm({ title: t("ui.confirm.buildIndex"), description: tf("ui.knowledge.document-library.sendPendingChunksFromDocumentsTo", { v0: targets.length, v1: formatList(models) }) })) || operation.current) return;
    await run(async signal => {
      const items = await maintainDocumentIndexes(targets, signal, items => { if (!signal.aborted || operation.current?.signal === signal) setProgress(items); });
      if (!signal.aborted) {
        const failure = items.find(item => item.status === "failed");
        if (failure) setError(failure.error ?? t("ui.knowledge.document-library.indexingFailedCompletedBatchesArePreserved"));
        toast(tf("ui.knowledge.document-library.indexingDocumentsCompleteUnfinishedItemsCan", { v0: items.filter(item => item.status === "complete").length, v1: items.length }));
        try { await refresh(signal); } catch { if (!signal.aborted) setError(t("ui.knowledge.document-library.indexBatchesFinishedButStatusRefresh")); }
        setResults(null); setDiagnostics(null);
      } else if (operation.current?.signal === signal) toast(t("ui.knowledge.document-library.indexingCancelledCompletedBatchesArePreserved"));
    });
  }

  // Read again when the window comes back into view, instead of a refresh button.
  useRefreshOnReturn(() => refresh());

  // The card opens with the keyboard on its first field, and closing it drops whatever it was holding.
  const importCard = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (importOpen) importCard.current?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
  }, [importOpen]);
  function closeImport() {
    if (importing) operation.current?.abort();
    setPreview(null); previewData.current = null; setError(""); setSelected([]); setBatch(null);
    onImportClose();
  }
  const listed = mode === "overview" ? documents.slice(0, OVERVIEW_DOCUMENTS) : documents;
  // `hidden` alone loses to the flex layout class, so the class that hides it travels with the attribute.
  return <section aria-label={t("documents.libraryTitle")} className={hidden ? "hidden" : "flex min-w-0 flex-col gap-4"} hidden={hidden}>
    {mode === "overview" ? <header className="knowledge-section-head justify-between">
      <div className="flex items-baseline gap-2"><h2 className="text-base font-semibold tracking-title">{t("documents.libraryTitle")}</h2><span className="text-xs text-muted-foreground">{documents.length} {t("ui.knowledge.document-library.documents")}</span></div>
      {documents.length ? <button type="button" className="see-all-link" onClick={onShowAll}>{tf("knowledge.showAllCount", { count: documents.length })}<ChevronRight aria-hidden="true" /></button> : null}
    </header> : null}
    {/* Closed, it gives back the gap above it, so it takes no room until it opens. */}
    <Reveal className="-mt-4">{importOpen ? <div ref={importCard} className="knowledge-import-card mt-4" data-dragging={dragging || undefined}
      onDragOver={event => { if (!busy && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); if (!busy) choose(Array.from(event.dataTransfer.files)); }}>
      <form onSubmit={event => void upload(event)} aria-label={t("ui.knowledge.document-library.importKnowledgeDocuments")}>
        <FieldGroup className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
          <Field className="min-w-0 gap-2"><FieldLabel className="text-xs" htmlFor="knowledge-document-file">{t("documents.fileLabel")}</FieldLabel><FileInput id="knowledge-document-file" accept={DOCUMENT_EXTENSIONS.join(",")} aria-label={t("documents.fileLabel")} buttonLabel={t("documents.fileButton")} placeholder={formatList(["PDF", "Word", "Markdown", "TXT"])} disabled={busy} name="file" multiple required={selected.length === 0} onChange={event => choose(Array.from(event.target.files ?? []))} /></Field>
          <Field className="min-w-0 gap-2"><FieldLabel className="text-xs" htmlFor="knowledge-document-collection">{t("documents.collectionLabel")}</FieldLabel><Input id="knowledge-document-collection" aria-label={t("documents.collectionLabel")} disabled={busy} list="document-collections" name="collection" onChange={event => { setCollection(event.target.value); setPreview(null); previewData.current = null; }} placeholder={t("documents.collectionPlaceholder")} value={collection} /><datalist id="document-collections">{[...new Set(documents.map(document => document.collection).filter((value): value is string => Boolean(value)))].map(value => <option key={value} value={value} />)}</datalist></Field>
          <div className="flex items-center gap-1">
            <Button disabled={busy} type="submit">{importing ? <Spinner data-icon="inline-start" /> : <Upload data-icon="inline-start" />}{selected.length > 1 ? tf("documents.batch.importCount", { count: selected.filter(isDocumentFile).length }) : t("documents.previewImport")}</Button>
            {/* A whole folder: its readable documents, subfolders included, go in as one batch. */}
            <Button asChild type="button" variant="ghost" title={t("documents.batch.chooseFolder")} className={busy ? "pointer-events-none opacity-45" : undefined}><label>
              <FolderOpen data-icon="inline-start" />{t("documents.batch.folder")}
              <input type="file" className="sr-only" multiple aria-label={t("documents.batch.chooseFolder")} disabled={busy} {...{ webkitdirectory: "" }} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) choose(files); }} />
            </label></Button>
            <Button type="button" variant="ghost" onClick={closeImport}>{t("knowledge.cancelEdit")}</Button>
          </div>
        </FieldGroup>
      </form>
      <details className="settings-disclosure knowledge-disclosure group"><summary className="settings-disclosure-trigger py-1 text-xs text-muted-foreground"><Info className="size-3.5" aria-hidden="true" />{t("ui.knowledge.document-library.importPrivacyInformation")}<ChevronRight className="size-3 transition-transform duration-[--dur-fast] group-open:rotate-90" aria-hidden="true" /></summary><div className="flex max-w-3xl flex-col gap-2 py-3 text-xs leading-6 text-muted-foreground"><p>{t("documents.libraryDescription")}</p><p>{t("documents.textOnlyNote")}</p><p>{t("ui.knowledge.document-library.importShowsAnExtractionPreviewFirst")}</p></div></details>
      {selected.length > 1 && !batch ? <p role="status" className="text-xs text-muted-foreground">{tf("documents.batch.selected", { count: selected.length, readable: selected.filter(isDocumentFile).length })}</p> : null}
      {batch ? <BatchList items={batch} running={importing} onStop={() => operation.current?.abort()}
        onRetry={() => void importAll(batch.map(item => item.status === "failed" || item.status === "waiting" ? { ...item, status: "waiting" as const, message: undefined } : item))}
        onDismiss={() => { setBatch(null); setSelected([]); }} /> : null}
      {preview ? <section className="knowledge-preview surface-enter flex flex-col gap-3 rounded-xl bg-muted/40 p-4" aria-label={t("ui.knowledge.document-library.documentImportPreview")}>
        <h3 className="break-words text-sm font-medium">{t("ui.knowledge.document-library.preview")}{preview.filename} · {preview.chunks.length} {t("ui.knowledge.document-library.chunks")}{preview.characterCount} {t("documents.characterUnit")}</h3>
        {preview.notes.map(note => <p className="text-xs leading-6 text-muted-foreground" key={note}>{note}</p>)}
        {preview.base ? <p className="text-xs leading-6">{t("ui.knowledge.document-library.confirmingUpdatesTheDocumentWithThe")}</p> : null}
        <div className="chat-list-scroll flex max-h-64 flex-col gap-3 overflow-y-auto">{preview.chunks.map(chunk => <div key={chunk.ordinal} className="flex flex-col gap-1"><p className="text-xs text-muted-foreground">{t("documents.chunkLabel")}{chunk.ordinal + 1}{chunk.heading ? ` · ${chunk.heading}` : ""}{chunk.pageNumber ? tf("ui.knowledge.document-library.page", { v0: chunk.pageNumber }) : ""}</p><pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6 [overflow-wrap:anywhere]">{chunk.text}</pre></div>)}</div>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void savePreview()}>{t("ui.knowledge.document-library.confirmDocumentSave")}</Button><Button size="sm" disabled={busy} variant="ghost" onClick={() => { setPreview(null); previewData.current = null; }}>{t("ui.knowledge.document-library.discardPreview")}</Button></div>
      </section> : null}
    </div> : null}</Reveal>
    <Reveal className="-mt-4">{error ? <Alert variant="destructive" className="mt-4"><AlertTitle>{t("ui.knowledge.document-library.documentOperationIncomplete")}</AlertTitle><AlertDescription><span>{localizeMessage(error)}</span><Button size="sm" variant="ghost" className="ml-2 h-auto px-2 py-0.5 align-baseline" onClick={() => void run(refresh)}>{t("ui.chat.chat-toolbar.retry")}</Button></AlertDescription></Alert> : null}</Reveal>
    {mode === "full" ? <>
      {/* Searching the content may embed the query, so it runs on Enter rather than as you type. */}
      <form aria-label={t("ui.knowledge.document-library.searchDocumentKnowledge")} onSubmit={event => void search(event)}>
        <FieldGroup className="flex flex-row flex-wrap items-center gap-2">
          <Field className="w-auto"><FieldLabel className="sr-only" htmlFor="knowledge-document-scope">{t("ui.knowledge.document-library.searchKnowledgeCollections")}</FieldLabel><SelectField id="knowledge-document-scope" aria-label={t("ui.knowledge.document-library.searchKnowledgeCollections")} disabled={busy} value={searchCollection} onValueChange={value => { setSearchCollection(value); setResults(null); }}><SelectOption value="">{t("ui.knowledge.document-library.allCollections")}</SelectOption>{[...new Set([...documents.flatMap(document => document.collection ? [document.collection] : []), ...(searchCollection ? [searchCollection] : [])])].sort().map(name => <SelectOption key={name} value={name}>{name}{documents.some(document => document.collection === name) ? "" : t("ui.knowledge.document-library.noKnowledgeYet")}</SelectOption>)}</SelectField></Field>
          <Field className="min-w-0 flex-1 basis-48"><FieldLabel htmlFor="knowledge-document-query" className="sr-only">{t("documents.searchLabel")}</FieldLabel><ToolbarSearch id="knowledge-document-query" aria-label={t("documents.searchLabel")} disabled={busy} maxLength={2000} onChange={event => setQuery(event.target.value)} placeholder={t("documents.searchPlaceholder")} required value={query} /></Field>
        </FieldGroup>
      </form>
      {results?.length === 0 ? <p role="status" className="text-sm leading-6 text-muted-foreground">{t("documents.noMatches")}</p> : null}
      <DocumentSources sources={results ?? []} />
    </> : null}
    {awaitingFirstDocumentLoad ? <div className="flex flex-col gap-2" aria-label={t("documents.loading")}><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div> : !documents.length ? <Empty className="py-6"><EmptyHeader><EmptyMedia><FileText /></EmptyMedia><EmptyTitle>{t("documents.empty")}</EmptyTitle><EmptyDescription>{t("ui.knowledge.document-library.importKnowledgeToSearchItHere")}</EmptyDescription></EmptyHeader></Empty> : <ul aria-label={t("documents.importedTitle")} className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 7.5rem 5.5rem 4rem auto", "--cols-narrow": "minmax(0, 1fr) 5.5rem auto" } as React.CSSProperties}>
      {listed.map(document => <li className="item-row data-row knowledge-document-row min-w-0" key={document.id} {...removalKey(document.id)}>
        <span className="item-row-icon"><FileText aria-hidden="true" /></span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2"><Link className="min-w-0 break-words text-sm font-medium hover:underline underline-offset-4 [overflow-wrap:anywhere]" href={`/knowledge/documents/${document.id}`}>{document.filename}</Link>{document.collection && <span className="min-w-0 truncate rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground">{document.collection}</span>}</div>
        </div>
        <span className="col-meta col-optional">{document._count.chunks} {t("documents.chunkUnit")} · {formatNumber(document.characterCount)} {t("documents.characterUnit")}</span>
        <span className="col-meta col-optional">{(readiness => readiness ? <Status tone={readiness.tone} title={readiness.detail}>{readiness.label}</Status> : null)(documentReadiness(document, automaticIndexing.running))}</span>
        <time className="col-meta col-end" dateTime={document.indexedAt} title={new Date(document.indexedAt).toLocaleString(t("documents.dateLocale"))}>{formatRelativeTime(document.indexedAt)}</time>
        <div className="flex shrink-0 items-center justify-end gap-0.5">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={tf("ui.assistants.moreActionsFor", { v0: document.filename })} disabled={busy}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {document.ocr?.status === "failed" ? <DropdownMenuItem aria-label={`${t("documents.ocrRetry")} ${document.filename}`} title={document.ocr.error ?? undefined} onSelect={() => void run(async () => { await documentRequest(`/api/documents/${document.id}/ocr`, { method: "POST" }); await refresh(); toast(t("documents.ocrRetrying")); })}><ScanText aria-hidden="true" />{t("documents.ocrRetry")}</DropdownMenuItem> : null}
              <DropdownMenuItem aria-label={`${t("documents.reindex")} ${document.filename}`} onSelect={() => void run(async () => { await documentRequest(`/api/documents/${document.id}`, { method: "POST" }); await refresh(); setResults(null); toast(t("documents.reindexed")); })}><RotateCw aria-hidden="true" />{t("documents.reindex")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" aria-label={`${t("documents.deleteLabel")} ${document.filename}`} onSelect={async () => { if (await confirm({ title: t("ui.confirm.deleteDocument"), description: `${t("documents.deleteConfirmPrefix")}${document.filename}${t("documents.deleteConfirmSuffix")}`, action: t("ui.confirm.delete"), destructive: true })) void run(async () => { await documentRequest(`/api/documents/${document.id}`, { method: "DELETE" }); await animateRemoval(document.id, refresh); setResults(null); toast(t("documents.deleted")); }); }}><Trash2 aria-hidden="true" />{t("documents.delete")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>)}
    </ul>}
    {mode === "full" ? <>
      {/* Index upkeep and retrieval checks only mean something once there is a document. */}
      <Reveal>{documents.length > 0 ? <div className="flex flex-col">
        <IndexStatus documents={documents} progress={progress} busy={busy} automatic={automaticIndexing} start={() => void buildSemanticIndexes(documents.filter(document => document.semantic?.modelRef && document.semantic.indexed < document.semantic.total))} cancel={() => operation.current?.abort()} lastSearch={results !== null ? diagnostics : null}>
          <RetrievalEvaluation />
        </IndexStatus>
      </div> : null}</Reveal>
    </> : null}
  </section>;
}

const BATCH_TONES: Record<BatchStatus, "neutral" | "success" | "warning" | "danger"> = { waiting: "neutral", importing: "neutral", retrying: "warning", added: "success", updated: "success", unchanged: "neutral", failed: "danger", skipped: "warning" };

/** A batch import as it goes: each document's state, and what can be done with the batch now. */
function BatchList({ items, running, onStop, onRetry, onDismiss }: { items: BatchItem[]; running: boolean; onStop: () => void; onRetry: () => void; onDismiss: () => void }) {
  const settled = items.filter(item => !["waiting", "importing", "retrying"].includes(item.status)).length;
  const label = (item: BatchItem) => item.status === "retrying" ? tf("documents.batch.status.retrying", { seconds: item.retryInSeconds ?? 0 }) : t(`documents.batch.status.${item.status as Exclude<BatchStatus, "retrying">}`);
  return <section aria-label={t("documents.batch.title")} className="knowledge-batch surface-enter flex flex-col gap-3 rounded-xl bg-muted/40 p-4">
    <h3 className="text-sm font-medium" role="status">{tf("documents.batch.progress", { settled, total: items.length })}</h3>
    <ul className="chat-list-scroll flex max-h-64 flex-col gap-1.5 overflow-y-auto text-xs">
      {items.map(item => <li key={item.id} className="flex min-w-0 items-center gap-3" data-status={item.status}>
        <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
        {item.message ? <span className="min-w-0 max-w-[45%] truncate text-muted-foreground" title={localizeMessage(item.message)}>{localizeMessage(item.message)}</span> : null}
        <Status tone={BATCH_TONES[item.status]}>{item.status === "importing" ? <Spinner aria-hidden="true" className="size-3" /> : null}{label(item)}</Status>
      </li>)}
    </ul>
    <div className="flex flex-wrap gap-2">
      {running ? <Button size="sm" variant="outline" onClick={onStop}>{t("documents.batch.stop")}</Button> : <>
        {items.some(item => item.status === "failed" || item.status === "waiting") ? <Button size="sm" onClick={onRetry}><RotateCw data-icon="inline-start" />{t("documents.batch.retry")}</Button> : null}
        <Button size="sm" variant="ghost" onClick={onDismiss}>{t("documents.batch.dismiss")}</Button>
      </>}
    </div>
  </section>;
}
