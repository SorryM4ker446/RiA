"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { documentRequest } from "@/features/knowledge/document-library";
import { t } from "@/lib/locale";

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
  return <main className="mx-auto max-w-4xl space-y-4 px-6 py-8">
    <Link className="text-sm text-muted-foreground transition-colors hover:text-foreground" href="/knowledge">{t("documents.backToLibrary")}</Link>
    <h1 className="break-all text-xl font-semibold tracking-headline">{document?.filename ?? t("documents.fallbackTitle")}</h1>
    <p className="text-sm leading-6 text-muted-foreground">{t("documents.extractedTextNote")}</p>
    {error ? <p role="alert" className="text-destructive">{error}</p> : !document ? <p>{t("documents.loading")}</p> : null}
    {outdated ? <p className="text-sm text-muted-foreground" role="status">{t("documents.outdated")}</p> : null}
    {document?.chunks.map(chunk => <section className="scroll-mt-6 rounded-lg bg-card p-4 shadow-hairline target:ring-2 target:ring-ring/70" id={chunk.id} key={chunk.id}>
      <h2 className="label-mono mb-2">{t("documents.chunkLabel")} {chunk.ordinal + 1}{chunk.pageNumber ? ` · ${t("documents.pageLabel")} ${chunk.pageNumber} ${t("documents.pageUnit")}` : ""}</h2>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{chunk.text}</p>
    </section>)}
  </main>;
}
