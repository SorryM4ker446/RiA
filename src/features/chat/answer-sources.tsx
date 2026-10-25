"use client";

import type { UIMessage } from "ai";
import { FileText, Globe } from "lucide-react";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { documentSourceUrl } from "@/lib/documents/types";
import { getDocumentSources, getWebSearchSources } from "@/features/chat/message-presentation";

/** How many sources show as cards; the rest are counted, with the full list in the execution records. */
const SHOWN = 4;

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * The sources an answer drew on, as a row of small cards right under it: the
 * site or document, and the page or heading. The details (snippets, scores,
 * diagnostics) stay in the execution records, one click away.
 */
export function AnswerSources({ message, onShowAll }: { message: UIMessage; onShowAll: () => void }) {
  useLocale();
  const toolParts = message.parts.filter((part): part is Extract<UIMessage["parts"][number], { type: `tool-${string}` }> => part.type.startsWith("tool-"));
  const web = getWebSearchSources(toolParts).map(source => ({ key: `web:${source.url}`, href: source.url, external: true, icon: Globe, title: source.title || hostOf(source.url), detail: hostOf(source.url) }));
  const documents = getDocumentSources(message).map(source => ({ key: `doc:${source.chunkId}`, href: documentSourceUrl(source), external: false, icon: FileText, title: source.filename, detail: source.pageNumber ? tf("chat.sources.page", { page: source.pageNumber }) : source.heading ?? "" }));
  const sources = [...new Map([...web, ...documents].map(source => [source.key, source])).values()];
  if (!sources.length) return null;
  return <nav aria-label={t("ui.chat.execution-turn-details.sourcesUsed")} className="answer-sources">
    {sources.slice(0, SHOWN).map(source => <a key={source.key} href={source.href} className="answer-source" {...(source.external ? { target: "_blank", rel: "noreferrer" } : {})}>
      <source.icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{source.title}</span>
      {source.detail ? <span className="shrink-0 truncate text-muted-foreground">{source.detail}</span> : null}
    </a>)}
    {sources.length > SHOWN ? <button type="button" className="answer-source" onClick={onShowAll}>{tf("chat.sources.more", { count: sources.length - SHOWN })}</button> : null}
  </nav>;
}
