"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Layers, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ListHead } from "@/components/layout/page-toolbar";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { documentRequest } from "@/features/knowledge/document-client";
import { TopicEditor } from "@/features/topics/topic-editor";
import type { TopicConfig, TopicSummary } from "@/lib/topics/schema";
import type { AssistantTemplate } from "@/lib/assistants/schema";
const blank: TopicConfig = { name: "", description: "", collections: [], assistantTemplateId: null };
export default function TopicsPage() {
  useLocale();
  const [topics, setTopics] = useState<TopicSummary[]>([]); const [assistants, setAssistants] = useState<AssistantTemplate[]>([]); const [collections, setCollections] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); const [creating, setCreating] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const operation = useRef<AbortController | null>(null);
  async function load(signal: AbortSignal) {
    const [items, templates, documents] = await Promise.all([documentRequest<TopicSummary[]>("/api/topics", { signal }), documentRequest<AssistantTemplate[]>("/api/assistants", { signal }), documentRequest<Array<{ collection: string | null }>>("/api/documents", { signal })]);
    if (!signal.aborted) { setTopics(items); setAssistants(templates); setCollections([...new Set(documents.flatMap(doc => doc.collection ? [doc.collection] : []))]); }
  }
  useEffect(() => { const controller = new AbortController(); operation.current = controller; load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (operation.current === controller) { operation.current = null; setLoading(false); } }); return () => { controller.abort(); operation.current?.abort(); operation.current = null; }; }, []);
  async function save(config: TopicConfig) {
    if (operation.current) return; const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try { await documentRequest("/api/topics", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
      if (!controller.signal.aborted) { setCreating(false); try { await load(controller.signal); } catch { setError(t("ui.topics.topicSavedButRefreshingTheList")); } }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t("ui.topics.saveFailed")); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  return <main className="mx-auto flex max-w-5xl flex-col gap-6">
    <PageHeader title={t("ui.topics.knowledgeTopicWorkspace")} description={t("ui.topics.organizeCollectionsADefaultAssistantConversations")} actions={<Button size="sm" disabled={loading || busy || creating} onClick={() => setCreating(true)}><Plus data-icon="inline-start" />{t("ui.topics.newTopic")}</Button>} />
    <Reveal className="-mt-6">{error ? <p role="alert" className="mt-6 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p> : null}</Reveal>
    {creating ? <section aria-label={t("ui.topics.newTopic")} className="surface surface-enter"><div className="flex flex-col gap-4 p-5"><h2 className="text-base font-semibold tracking-title">{t("ui.topics.newTopic")}</h2><TopicEditor initial={blank} assistants={assistants} collections={collections} busy={busy} save={save} cancel={() => setCreating(false)} /></div></section> : null}
    {loading ? <p className="text-sm text-muted-foreground">{t("ui.topics.loadingTopics")}</p> : !topics.length ? <p className="empty-state">{t("ui.topics.noTopicsYetCreateOneTo")}</p> : <ul className="item-list" style={{ "--cols": "20px minmax(0, 1fr) minmax(0, 8rem) 3.5rem 3.5rem", "--cols-narrow": "minmax(0, 1fr) 3rem 3rem" } as React.CSSProperties}><ListHead><span className="col-optional" /><span>{t("ui.columns.name")}</span><span className="col-optional">{t("ui.columns.collections")}</span><span className="col-end">{t("ui.columns.conversations")}</span><span className="col-end">{t("ui.columns.artifacts")}</span></ListHead>{topics.map(topic => <li key={topic.id} className="item-row data-row">
      <span className="item-row-icon"><Layers aria-hidden="true" /></span>
      <div className="flex min-w-0 flex-col gap-0.5"><h3 className="text-sm font-medium"><Link className="item-row-open break-words" href={`/topics/${topic.id}`}>{topic.config.name}</Link></h3>
        {topic.config.description ? <p className="line-clamp-1 break-words text-xs text-muted-foreground">{topic.config.description}</p> : null}</div>
      <span className="col-meta col-optional">{topic.config.collections.join("、")}</span>
      <span className="col-meta col-end">{topic._count.chats}</span>
      <span className="col-meta col-end">{topic._count.artifacts}</span>
    </li>)}</ul>}
  </main>;
}
