"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  return <main className="mx-auto flex max-w-6xl flex-col gap-6"><header className="workspace-page-header"><h1>{t("ui.topics.knowledgeTopicWorkspace")}</h1><Button disabled={loading || busy} onClick={() => setCreating(value => !value)}>{t("ui.topics.newTopic")}</Button></header>
    <p className="text-sm text-muted-foreground">{t("ui.topics.organizeCollectionsADefaultAssistantConversations")}</p>
    {error ? <p role="alert" className="text-sm text-destructive">{localizeMessage(error)}</p> : null}
    {creating ? <Card><CardHeader><CardTitle>{t("ui.topics.newTopic")}</CardTitle></CardHeader><CardContent><TopicEditor initial={blank} assistants={assistants} collections={collections} busy={busy} save={save} cancel={() => setCreating(false)} /></CardContent></Card> : null}
    {loading ? <p>{t("ui.topics.loadingTopics")}</p> : !topics.length ? <p className="text-sm">{t("ui.topics.noTopicsYetCreateOneTo")}</p> : <ul className="grid gap-3 sm:grid-cols-2">{topics.map(topic => <li key={topic.id}><Card><CardHeader><CardTitle><Link className="break-words underline underline-offset-4" href={`/topics/${topic.id}`}>{topic.config.name}</Link></CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p className="break-words">{topic.config.description}</p><p className="break-words">{t("ui.topics.knowledge")}{topic.config.collections.join("、")}</p><p>{topic._count.chats} {t("ui.topics.conversations")}{topic._count.artifacts} {t("ui.topics.artifacts")}</p></CardContent></Card></li>)}</ul>}
  </main>;
}
