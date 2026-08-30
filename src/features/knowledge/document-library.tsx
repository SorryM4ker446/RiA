"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { DOCUMENT_LIMITS, type DocumentSource } from "@/lib/documents/types";

type DocumentSummary = { id: string; filename: string; characterCount: number; indexedAt: string; _count: { chunks: number } };

export async function documentRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, "文档操作失败，请稍后重试。"));
  return payload.data as T;
}

export function DocumentLibrary() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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

  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : "文档操作失败。"); }
    finally { setBusy(false); }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || !file.size) { setError("请先选择文档。"); return; }
    if (file.size > DOCUMENT_LIMITS.fileBytes) { setError("文档不能超过 8 MiB。"); return; }
    await run(async () => {
      const result = await documentRequest<{ change: string; added: number; retained: number; removed: number }>("/api/documents", { method: "POST", body: data });
      form.reset(); setResults(null);
      await refresh();
      setNotice(result.change === "unchanged" ? "文档内容未变化，已保留现有索引。" : `文档已保存：新增 ${result.added}、复用 ${result.retained}、移除 ${result.removed} 个片段。`);
    });
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    await run(async () => setResults(await documentRequest<DocumentSource[]>("/api/documents/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) })));
  }

  return <Card>
    <CardHeader>
      <CardTitle>文档知识库</CardTitle>
      <CardDescription>本地解析和检索 PDF、Markdown、TXT、Word .docx；每份最多 8 MiB、十万字符，最多保存 100 份。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">仅保存提取文本，不保留原文件及排版。同名文件会更新原文档并复用未变化的片段。聊天时，命中的片段会随问题发送给你配置的模型。扫描 PDF 请先 OCR，旧版 .doc 请先转换为 .docx。</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => void upload(event)}>
        <label className="min-w-0 flex-1 space-y-1 text-sm">选择知识文档
          <Input accept=".pdf,.md,.txt,.docx" disabled={busy} name="file" required type="file" />
        </label>
        <Button disabled={busy} type="submit">{busy ? "处理中…" : "导入文档"}</Button>
      </form>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      <div className="flex items-center justify-between">
        <h2 className="font-medium">已导入文档（{documents.length}）</h2>
        <Button disabled={busy} onClick={() => void run(refresh)} size="sm" variant="secondary">刷新文档</Button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">正在读取文档…</p> : !documents.length ? <p className="text-sm text-muted-foreground">暂无导入文档。</p> : <ul className="max-h-96 space-y-2 overflow-y-auto">
        {documents.map(document => <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" key={document.id}>
          <div className="min-w-0">
            <Link className="break-all text-sm font-medium underline" href={`/knowledge/documents/${document.id}`}>{document.filename}</Link>
            <p className="mt-1 text-xs text-muted-foreground">{document._count.chunks} 个片段 · {document.characterCount.toLocaleString()} 字符 · 索引时间 {new Date(document.indexedAt).toLocaleString("zh-CN")}</p>
          </div>
          <div className="flex gap-1">
            <Button aria-label={`重新索引 ${document.filename}`} disabled={busy} size="sm" variant="secondary" onClick={() => void run(async () => {
              await documentRequest(`/api/documents/${document.id}`, { method: "POST" }); await refresh(); setResults(null); setNotice("已根据保存的文本重建索引。");
            })}>重新索引</Button>
            <Button aria-label={`删除文档 ${document.filename}`} disabled={busy} size="sm" variant="ghost" onClick={() => {
              if (window.confirm(`删除文档「${document.filename}」及其索引？已有聊天中的引用摘录会保留。`)) void run(async () => {
                await documentRequest(`/api/documents/${document.id}`, { method: "DELETE" }); await refresh(); setResults(null); setNotice("文档及索引已删除。");
              });
            }}>删除</Button>
          </div>
        </li>)}
      </ul>}
      <form className="flex flex-wrap gap-2 border-t pt-4" onSubmit={event => void search(event)}>
        <Input aria-label="检索文档" className="min-w-0 flex-1" disabled={busy} maxLength={2000} onChange={event => setQuery(event.target.value)} placeholder="检索已导入文档中的内容" required value={query} />
        <Button disabled={busy || !query.trim()} type="submit" variant="secondary">检索文档</Button>
      </form>
      {results?.length === 0 ? <p role="status" className="text-sm text-muted-foreground">没有匹配的文档片段，请尝试文档中的关键词。</p> : null}
      <DocumentSources sources={results ?? []} />
    </CardContent>
  </Card>;
}
