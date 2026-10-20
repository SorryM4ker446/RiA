"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf } from "@/lib/locale";

import { useEffect, useState } from "react";
import Link from "next/link";
import { documentSourceUrl, type DocumentReferenceStatus, type DocumentSource } from "@/lib/documents/types";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export function DocumentSources({ sources, compact = false }: { sources: DocumentSource[]; compact?: boolean }) {
  useLocale();
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
  return <details className={cn(compact ? "execution-disclosure text-xs" : "mt-3 rounded-lg bg-muted text-xs")} open={!compact || undefined}>
    <summary className={cn(!compact && "cursor-pointer px-3 py-2 font-medium tracking-label")}>{compact ? <ChevronRight aria-hidden="true" /> : null}{t("documents.sourcesTitle")}{t("documents.countOpen")}{sources.length}{t("documents.countClose")}</summary>
    <p className={cn("text-muted-foreground", compact ? "py-1 pl-5" : "px-3")}>{t("documents.sourcesNote")}</p>
    <ol className={cn("flex min-w-0 flex-col gap-3", compact ? "py-2 pl-5" : "p-3")}>
      {sources.map(source => <li key={source.chunkId}>
        {source.citationStatus ? <p className="mb-1 font-medium">{source.citationStatus === "cited" ? t("ui.knowledge.document-sources.thisExcerptWasCitedInThe") : t("ui.knowledge.document-sources.retrievedReferenceNotCitedInThe")}</p> : null}
        <Link className="font-medium tracking-label underline underline-offset-4 hover:no-underline" href={documentSourceUrl(source)}>{source.filename} · {source.pageNumber ? `${t("documents.pageLabel")} ${source.pageNumber} ${t("documents.pageUnit")}` : `${t("documents.chunkLabel")} ${source.ordinal + 1}`}</Link>
        <p className="mt-1 text-muted-foreground">{source.retrieval ? tf("ui.knowledge.document-sources.collection", { v0: ({ "local-keyword": t("ui.retrieval.keyword"), semantic: t("ui.retrieval.semantic"), hybrid: t("ui.retrieval.hybrid"), neighbor: t("ui.retrieval.neighbor") })[source.retrieval], v1: source.collection ?? t("ui.retrieval.uncategorized"), v2: source.heading ? tf("ui.retrieval.heading", { v0: source.heading }) : "", v3: source.matchedTerms?.length ? tf("ui.retrieval.matchedTerms", { v0: source.matchedTerms.join("、") }) : "" }) : t("ui.knowledge.document-sources.retrievalMethodNotRecordedInOlder")}</p>
        <p role="status" className="mt-1 text-muted-foreground">{!statuses ? t("ui.knowledge.document-sources.checkingCitationVersion") : statuses.failed ? t("ui.knowledge.document-sources.citationVersionCouldNotBeChecked") : ({ current: t("ui.knowledge.document-sources.citationVersionMatchesVerified"), changed: t("ui.knowledge.document-sources.sourceUpdatedTheExcerptBelowPreserves"), deleted: t("ui.knowledge.document-sources.sourceDeletedOnlyTheHistoricalExcerpt"), unverified: t("ui.knowledge.document-sources.thisOlderCitationLacksVersionInformation") })[statuses?.rows.find(row => row.chunkId === source.chunkId)?.status ?? "unverified"]}</p>
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">{source.snippet}</p>
      </li>)}
    </ol>
  </details>;
}
