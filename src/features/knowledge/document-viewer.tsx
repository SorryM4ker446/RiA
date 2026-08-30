"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { documentRequest } from "@/features/knowledge/document-library";

type DocumentView = { filename: string; chunks: { id: string; text: string; ordinal: number; pageNumber: number | null }[] };
export function DocumentViewer({ id }: { id: string }) {
  const [document, setDocument] = useState<DocumentView | null>(null);
  const [error, setError] = useState("");
  const [outdated, setOutdated] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    documentRequest<DocumentView>(`/api/documents/${encodeURIComponent(id)}`, { signal: controller.signal }).then(value => {
      setDocument(value);
      const chunkId = window.location.hash.slice(1);
      setOutdated(Boolean(chunkId && !value.chunks.some(chunk => chunk.id === chunkId)));
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (!document || !window.location.hash) return;
    const chunkId = window.location.hash.slice(1);
    const element = window.document.getElementById(chunkId);
    if (element) element.scrollIntoView({ block: "center" });
  }, [document]);
  return <main className="mx-auto max-w-4xl space-y-4 p-6">
    <Link className="text-sm underline" href="/knowledge">返回知识库</Link>
    <h1 className="break-all text-xl font-semibold">{document?.filename ?? "文档来源"}</h1>
    <p className="text-sm text-muted-foreground">以下为当前保存的提取文本，可能与原文件排版不同。相邻长片段包含少量重叠。</p>
    {error ? <p role="alert" className="text-destructive">{error}</p> : !document ? <p>正在读取文档…</p> : null}
    {outdated ? <p role="status">原引用片段已被更新或删除，以下展示文档当前版本；聊天中的摘录保留了回答时的内容。</p> : null}
    {document?.chunks.map(chunk => <section className="scroll-mt-6 rounded-md border p-4 target:border-primary target:bg-muted/50" id={chunk.id} key={chunk.id}>
      <h2 className="mb-2 text-xs text-muted-foreground">片段 {chunk.ordinal + 1}{chunk.pageNumber ? ` · 第 ${chunk.pageNumber} 页` : ""}</h2>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{chunk.text}</p>
    </section>)}
  </main>;
}
