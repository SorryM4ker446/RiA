"use client";

import { Loader2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { RetrievalEvaluation } from "./retrieval-evaluation";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { DOCUMENT_LIMITS, type DocumentSource } from "@/lib/documents/types";
import { t, tf } from "@/lib/locale";

import { documentRequest, type DocumentSummary, type DocumentPreview } from "./document-client";
import { maintainDocumentIndexes, type IndexProgress } from "./index-maintenance";
import { IndexStatus } from "./index-status";
export { documentRequest } from "./document-client";

export function DocumentLibrary() {
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
    catch (error) { if (operation.current === controller) { if (controller.signal.aborted) setNotice("操作已取消；已经保存的批次保留。"); else setError(error instanceof Error ? error.message : t("documents.actionFailed")); } }
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
      try { await refresh(signal); } catch { if (!signal.aborted) setError("文档已保存，但列表刷新失败，请刷新文档；无需重复保存。"); }
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
    if (!models.length || !window.confirm(`将 ${targets.length} 个文档的待索引片段发送给 ${models.join("、")}，可能产生费用。已完成批次保留。继续？`)) return;
    await run(async signal => {
      const items = await maintainDocumentIndexes(targets, signal, items => { if (!signal.aborted || operation.current?.signal === signal) setProgress(items); });
      if (!signal.aborted) {
        const failure = items.find(item => item.status === "failed");
        if (failure) setError(failure.error ?? "索引构建失败，已完成批次保留。");
        setNotice(`索引处理：完成 ${items.filter(item => item.status === "complete").length}/${items.length} 个文档；未完成项可继续。`);
        try { await refresh(signal); } catch { if (!signal.aborted) setError("索引批次处理结束，但状态刷新失败，请刷新文档；已完成批次保留。"); }
        setResults(null); setDiagnostics(null);
      } else if (operation.current?.signal === signal) setNotice("索引构建已取消，已完成批次保留；刷新文档后可继续。");
    });
  }

  return <Card>
    <CardHeader>
      <CardTitle>{t("documents.libraryTitle")}</CardTitle>
      <CardDescription>{t("documents.libraryDescription")}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">{t("documents.textOnlyNote")} 导入会先展示提取预览，确认保存后才写入知识库。</p>
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
            onChange={() => { setPreview(null); previewData.current = null; }}
            required
          />
        </div>
        <label className="min-w-0 flex-1 space-y-1.5 text-sm">
          <span>{t("documents.collectionLabel")}</span>
          <Input
            aria-label={t("documents.collectionLabel")}
            disabled={busy}
            list="document-collections"
            name="collection"
            onChange={(event) => { setCollection(event.target.value); setPreview(null); previewData.current = null; }}
            placeholder={t("documents.collectionPlaceholder")}
            value={collection}
          />
          <datalist id="document-collections">
            {[...new Set(documents.map((document) => document.collection).filter((value): value is string => Boolean(value)))]
              .map((value) => <option key={value} value={value} />)}
          </datalist>
        </label>
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
      {preview ? <section className="space-y-2 rounded-lg border p-3" aria-label="文档导入预览">
        <h3 className="break-words text-sm font-medium">预览：{preview.filename} · {preview.chunks.length} 个片段 · {preview.characterCount} 字符</h3>
        {preview.notes.map(note => <p className="text-xs text-muted-foreground" key={note}>{note}</p>)}
        {preview.base ? <p className="text-xs">确认保存将更新同名文档。原有引用保留旧片段快照。</p> : null}
        <div className="max-h-64 space-y-2 overflow-y-auto">{preview.chunks.map(chunk => <div key={chunk.ordinal}><p className="text-xs text-muted-foreground">片段 {chunk.ordinal + 1}{chunk.heading ? ` · ${chunk.heading}` : ""}{chunk.pageNumber ? ` · 第 ${chunk.pageNumber} 页` : ""}</p><pre className="whitespace-pre-wrap break-words text-xs">{chunk.text}</pre></div>)}</div>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void savePreview()}>确认保存文档</Button><Button disabled={busy} variant="outline" onClick={() => { setPreview(null); previewData.current = null; }}>放弃预览</Button></div>
      </section> : null}
      <IndexStatus documents={documents} progress={progress} busy={busy} start={() => void buildSemanticIndexes(documents.filter(document => document.semantic?.modelRef && document.semantic.indexed < document.semantic.total))} cancel={() => operation.current?.abort()} />
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
            {document.semantic?.lexicalCurrent === false ? <p className="mt-1 text-xs text-muted-foreground">本地索引待更新，请重新索引以保留表头上下文。</p> : null}
            <p className="mt-1 text-xs text-muted-foreground">{document.semantic?.modelRef ? `语义索引 ${document.semantic.indexed}/${document.semantic.total} · ${document.semantic.modelRef.modelId}${document.semantic.indexed < document.semantic.total ? " · 构建后可检索间接表述和同义问题" : ""}` : "当前使用本地关键词检索；配置 embedding 模型后可构建语义索引。"}</p>
          </div>
          <div className="flex gap-1">
            <Button aria-label={`构建语义索引 ${document.filename}`} disabled={busy || !document.semantic?.modelRef} size="sm" variant="outline" onClick={() => void buildSemanticIndexes([document])}>语义索引</Button>
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
        <select aria-label="检索资料集合" disabled={busy} value={searchCollection} onChange={event => { setSearchCollection(event.target.value); setResults(null); }} className="max-w-full rounded-md border bg-background px-2 text-sm">
          <option value="">全部集合</option>
          {[...new Set([...documents.flatMap(document => document.collection ? [document.collection] : []), ...(searchCollection ? [searchCollection] : [])])].sort().map(name => <option key={name} value={name}>{name}{documents.some(document => document.collection === name) ? "" : "（暂无资料）"}</option>)}
        </select>
        <Input aria-label={t("documents.searchLabel")} className="min-w-0 flex-1" disabled={busy} maxLength={2000} onChange={event => setQuery(event.target.value)} placeholder={t("documents.searchPlaceholder")} required value={query} />
        <Button disabled={busy || !query.trim()} type="submit" variant="secondary">{t("documents.search")}</Button>
      </form>
      {results?.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t("documents.noMatches")}</p> : null}
      <DocumentSources sources={results ?? []} />
      {results !== null ? <RetrievalDiagnostics value={diagnostics} /> : null}
      <RetrievalEvaluation />
    </CardContent>
  </Card>;
}
