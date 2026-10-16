"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { documentSourceUrl, type DocumentReferenceStatus, type DocumentSource } from "@/lib/documents/types";
import { t } from "@/lib/locale";

export function DocumentSources({ sources }: { sources: DocumentSource[] }) {
  const key = JSON.stringify(sources.slice(0, 8));
  const [check, setCheck] = useState<{ key: string; rows: DocumentReferenceStatus[]; failed: boolean } | null>(null);
  useEffect(() => {
    const selected = JSON.parse(key) as DocumentSource[];
    if (!selected.length) return;
    const controller = new AbortController();
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void fetch("/api/documents/references", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources: selected }), signal: controller.signal, cache: "no-store" })
        .then(async response => { if (!response.ok) throw new Error("Reference check failed"); return response.json(); })
        .then(payload => { if (!controller.signal.aborted && request === sequence) setCheck({ key, rows: payload.data, failed: false }); })
        .catch(() => { if (!controller.signal.aborted && request === sequence) setCheck({ key, rows: [], failed: true }); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [key]);
  const statuses = check?.key === key ? check : null;
  if (!sources.length) return null;
  return <details className="mt-3 rounded-lg bg-muted text-xs" open>
    <summary className="cursor-pointer px-3 py-2 font-medium tracking-label">{t("documents.sourcesTitle")}{t("documents.countOpen")}{sources.length}{t("documents.countClose")}</summary>
    <p className="px-3 text-muted-foreground">{t("documents.sourcesNote")}</p>
    <ol className="space-y-3 p-3">
      {sources.map(source => <li key={source.chunkId}>
        {source.citationStatus ? <p className="mb-1 font-medium">{source.citationStatus === "cited" ? "回答已引用此片段（仍需核对内容）" : "检索参考：回答未引用此片段"}</p> : null}
        <Link className="font-medium tracking-label underline underline-offset-4 hover:no-underline" href={documentSourceUrl(source)}>{source.filename} · {source.pageNumber ? `${t("documents.pageLabel")} ${source.pageNumber} ${t("documents.pageUnit")}` : `${t("documents.chunkLabel")} ${source.ordinal + 1}`}</Link>
        <p className="mt-1 text-muted-foreground">{source.retrieval ? `${({ "local-keyword": "本地关键词检索", semantic: "语义检索", hybrid: "混合检索", neighbor: "相邻上下文" })[source.retrieval]} · 集合：${source.collection ?? "未分类"}${source.heading ? ` · 章节：${source.heading}` : ""}${source.matchedTerms?.length ? ` · 匹配词：${source.matchedTerms.join("、")}` : ""}` : "旧引用未记录检索方式"}</p>
        <p role="status" className="mt-1 text-muted-foreground">{!statuses ? "正在核对引用版本…" : statuses.failed ? "引用版本暂时无法核对，请勿据此认定来源仍有效。" : ({ current: "引用版本一致（已核对）", changed: "资料已更新：下方保留回答时的摘录，链接展示当前资料。", deleted: "资料已删除：下方仅为历史摘录，原文已不可访问。", unverified: "旧引用缺少版本记录，无法确认与当前资料一致。" })[statuses?.rows.find(row => row.chunkId === source.chunkId)?.status ?? "unverified"]}</p>
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">{source.snippet}</p>
      </li>)}
    </ol>
  </details>;
}
