"use client";
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
      if (!controller.signal.aborted) { setCreating(false); try { await load(controller.signal); } catch { setError("专题已保存，但列表刷新失败，请刷新页面查看。"); } }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "保存失败"); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  }
  return <main className="mx-auto max-w-5xl space-y-4 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold">知识专题工作区</h1><Button disabled={loading || busy} onClick={() => setCreating(value => !value)}>新建专题</Button></div>
    <p className="text-sm text-muted-foreground">把资料集合、默认助理、会话和有引用的成果组织在同一个专题中。</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {creating ? <Card><CardHeader><CardTitle>新建专题</CardTitle></CardHeader><CardContent><TopicEditor initial={blank} assistants={assistants} collections={collections} busy={busy} save={save} cancel={() => setCreating(false)} /></CardContent></Card> : null}
    {loading ? <p>正在加载专题…</p> : !topics.length ? <p className="text-sm">还没有专题。创建后可以关联资料并开始工作。</p> : <ul className="grid gap-3 sm:grid-cols-2">{topics.map(topic => <li key={topic.id}><Card><CardHeader><CardTitle><Link className="break-words underline underline-offset-4" href={`/topics/${topic.id}`}>{topic.config.name}</Link></CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p className="break-words">{topic.config.description}</p><p className="break-words">资料：{topic.config.collections.join("、")}</p><p>{topic._count.chats} 个会话 · {topic._count.artifacts} 个成果</p></CardContent></Card></li>)}</ul>}
  </main>;
}
