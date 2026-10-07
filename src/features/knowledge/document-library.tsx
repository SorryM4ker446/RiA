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
import { getApiErrorMessage } from "@/lib/api-error-message";
import { DOCUMENT_LIMITS, type DocumentSource } from "@/lib/documents/types";
import { t, tf } from "@/lib/locale";

type DocumentSummary = { id: string; filename: string; contentHash: string; collection?: string | null; characterCount: number; indexedAt: string; _count: { chunks: number };
  semantic?: { indexed: number; total: number; modelRef: { providerId: string; modelId: string } | null } };

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
  const [collection, setCollection] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searchCollection, setSearchCollection] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentSource[] | null>(null);
  const indexRequest = useRef<AbortController | null>(null);
  async function refresh(signal?: AbortSignal) {
    const updated = await documentRequest<DocumentSummary[]>("/api/documents", { signal });
    if (!signal?.aborted) setDocuments(updated);
  }
  useEffect(() => {
    const controller = new AbortController();
    documentRequest<DocumentSummary[]>("/api/documents", { signal: controller.signal }).then(setDocuments).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); indexRequest.current?.abort(); };
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
    // Filed under a topic when one was given, so a conversation can be scoped
    // to it later.
    if (collection.trim()) data.set("collection", collection.trim());
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
    await run(async () => setResults(await documentRequest<DocumentSource[]>("/api/documents/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, collections: searchCollection ? [searchCollection] : [] }) })));
  }

  async function buildSemanticIndex(document: DocumentSummary) {
    if (busy || !document.semantic?.modelRef) return;
    const modelRef = document.semantic.modelRef;
    if (!window.confirm(`将「${document.filename}」的片段发送给 ${modelRef.modelId} 构建语义索引，可能产生费用。继续？`)) return;
    const controller = new AbortController();
    indexRequest.current = controller;
    setBusy(true); setError(""); setNotice("");
    try {
      for (let batch = 0; batch < 8; batch++) {
        const progress = await documentRequest<{ indexed: number; total: number; remaining: number }>(`/api/documents/${document.id}/embeddings`, {
          method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true, contentHash: document.contentHash, modelRef }),
        });
        if (controller.signal.aborted) return;
        setNotice(`语义索引：${progress.indexed}/${progress.total} 个片段`);
        setDocuments(current => current.map(item => item.id === document.id
          ? { ...item, semantic: { modelRef, indexed: progress.indexed, total: progress.total } } : item));
        if (!progress.remaining) break;
      }
      await refresh(controller.signal);
      if (!controller.signal.aborted) setResults(null);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : "语义索引构建失败；已完成的批次保留，再次构建可继续。");
      }
    } finally {
      if (indexRequest.current === controller) indexRequest.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
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
        <label className="min-w-0 flex-1 space-y-1.5 text-sm">
          <span>{t("documents.collectionLabel")}</span>
          <Input
            aria-label={t("documents.collectionLabel")}
            disabled={busy}
            list="document-collections"
            name="collection"
            onChange={(event) => setCollection(event.target.value)}
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
            <p className="mt-1 text-xs text-muted-foreground">{document.semantic?.modelRef ? `语义索引 ${document.semantic.indexed}/${document.semantic.total} · ${document.semantic.modelRef.modelId}${document.semantic.indexed < document.semantic.total ? " · 构建后可检索间接表述和同义问题" : ""}` : "当前使用本地关键词检索；配置 embedding 模型后可构建语义索引。"}</p>
          </div>
          <div className="flex gap-1">
            <Button aria-label={`构建语义索引 ${document.filename}`} disabled={busy || !document.semantic?.modelRef} size="sm" variant="outline" onClick={() => void buildSemanticIndex(document)}>语义索引</Button>
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
    </CardContent>
  </Card>;
}
