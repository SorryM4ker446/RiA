"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { documentRequest, DocumentRequestError, type DocumentSummary } from "@/features/knowledge/document-client";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { TopicEditor } from "./topic-editor";
import type { AssistantTemplate } from "@/lib/assistants/schema";
import type { TopicConfig, TopicSummary, ArtifactSummary, ArtifactDetail, ArtifactInput } from "@/lib/topics/schema";
import type { DocumentSource } from "@/lib/documents/types";

type Conversation = { id: string; title: string; archived: boolean };
const statuses: Record<ArtifactSummary["status"], string> = { generating: "生成中", ready: "已生成", needs_review: "引用待检查", failed: "生成失败", cancelled: "已取消", interrupted: "已中断" };
export function TopicWorkspace({ topicId }: { topicId: string }) {
  const router = useRouter(), base = `/api/topics/${topicId}`;
  const [topic, setTopic] = useState<TopicSummary | null>(null), [docs, setDocs] = useState<DocumentSummary[]>([]), [assistants, setAssistants] = useState<AssistantTemplate[]>([]);
  const [chats, setChats] = useState<Conversation[]>([]), [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]), [selected, setSelected] = useState<ArtifactDetail | null>(null);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [generating, setGenerating] = useState(false), [notice, setNotice] = useState("");
  const [title, setTitle] = useState(""), [brief, setBrief] = useState(""), [kind, setKind] = useState<ArtifactInput["kind"]>("summary"), [confirmed, setConfirmed] = useState(false);
  const [query, setQuery] = useState(""), [evidence, setEvidence] = useState<{ sources: DocumentSource[]; diagnostics: unknown } | null>(null);
  const operation = useRef<AbortController | null>(null), selection = useRef<AbortController | null>(null), pending = useRef<string | null>(null);
  const json = (method: string, value: unknown, signal: AbortSignal): RequestInit => ({ method, signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  async function load(signal: AbortSignal) {
    const [current, documents, templates, conversations, outputs] = await Promise.all([
      documentRequest<TopicSummary>(base, { signal }), documentRequest<DocumentSummary[]>("/api/documents", { signal }), documentRequest<AssistantTemplate[]>("/api/assistants", { signal }),
      documentRequest<Conversation[]>(`${base}/conversations`, { signal }), documentRequest<ArtifactSummary[]>(`${base}/artifacts`, { signal }),
    ]);
    if (!signal.aborted) { setTopic(current); setDocs(documents); setAssistants(templates); setChats(conversations); setArtifacts(outputs); }
  }
  useEffect(() => {
    const controller = new AbortController(); operation.current = controller;
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setNotice(error.message); }).finally(() => { if (operation.current === controller) { operation.current = null; setLoading(false); } });
    return () => { controller.abort(); operation.current?.abort(); selection.current?.abort(); operation.current = null; selection.current = null; };
    // The page is remounted when its topic identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return; selection.current?.abort(); selection.current = null;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setNotice("");
    try { await action(controller.signal); } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "操作失败，请刷新查看保存的状态。"); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); setGenerating(false); setLoading(false); } }
  }
  async function refresh(signal: AbortSignal) {
    await load(signal);
    const id = pending.current ?? selected?.id;
    if (id) {
      try { const item = await documentRequest<ArtifactDetail>(`${base}/artifacts/${id}`, { signal }); if (!signal.aborted) { setSelected(item); pending.current = null; } }
      catch (error) { if (error instanceof DocumentRequestError && error.status === 404) { pending.current = null; setSelected(null); setNotice("没有找到该成果记录，请检查列表后再主动生成。"); } else throw error; }
    }
  }
  async function openArtifact(id: string) {
    selection.current?.abort(); const controller = new AbortController(); selection.current = controller;
    try { const item = await documentRequest<ArtifactDetail>(`${base}/artifacts/${id}`, { signal: controller.signal }); if (!controller.signal.aborted && selection.current === controller) setSelected(item); }
    catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "成果读取失败"); }
    finally { if (selection.current === controller) selection.current = null; }
  }
  function openChat(id: string) { try { localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, id); } catch { setNotice("浏览器无法保存会话选择，请从聊天历史中打开该会话。"); return; } router.push("/chat"); }
  async function save(config: TopicConfig) { await run(async signal => {
    await documentRequest(base, json("PATCH", { revision: topic!.revision, ...config }, signal));
    if (!signal.aborted) { setEditing(false); setEvidence(null); setNotice("专题已保存；已有会话和成果保留原来的设置与快照。");
      try { await load(signal); } catch (error) { if (!signal.aborted) setNotice(`专题已保存，但页面刷新失败，请主动刷新。${error instanceof Error ? error.message : ""}`); }
    }
  }); }
  async function generate(signal: AbortSignal) {
    const requestId = crypto.randomUUID(); pending.current = requestId; setGenerating(true); selection.current?.abort(); setSelected(null);
    const item = await documentRequest<ArtifactDetail>(`${base}/artifacts`, json("POST", { confirm: true, requestId, revision: topic!.revision, title, kind, brief }, signal));
    if (!signal.aborted) { pending.current = null; setSelected(item); setConfirmed(false); setGenerating(false);
      try { await load(signal); } catch (error) { if (!signal.aborted) setNotice(`成果记录已保存，但页面刷新失败，请主动刷新。${error instanceof Error ? error.message : ""}`); }
    }
  }
  if (loading) return <main className="p-4">正在加载专题…</main>;
  const scoped = docs.filter(document => topic?.config.collections.includes(document.collection ?? ""));
  return <main className="mx-auto max-w-5xl space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="break-words text-xl font-semibold">{topic?.config.name ?? "知识专题"}</h1><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>刷新专题和成果</Button><Link className="self-center text-sm underline" href="/topics">全部专题</Link></div></div>
    {notice ? <p role="status" className="break-words rounded-lg border p-3 text-sm">{notice}</p> : null}
    {topic ? <>
      <p className="break-words text-sm text-muted-foreground">{topic.config.description} · 专题版本 {topic.revision}</p>
      <Card><CardHeader><CardTitle>资料与默认设置</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p className="break-words">集合：{topic.config.collections.join("、")}</p><p>默认助理：{assistants.find(item => item.id === topic.config.assistantTemplateId)?.config.name ?? (topic.config.assistantTemplateId ? "原模板已不可用，请修改设置" : "当前聊天默认模型")}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => setEditing(value => !value)}>修改专题设置</Button><Link className="self-center underline" href="/knowledge">管理资料与索引</Link></div>
        {editing ? <TopicEditor key={`${topic.id}:${topic.revision}`} initial={topic.config} assistants={assistants} collections={[...new Set(docs.flatMap(document => document.collection ? [document.collection] : []))]} busy={busy} save={save} cancel={() => setEditing(false)} /> : null}
        {!scoped.length ? <p>这些集合暂无文档，请导入资料后再检索或生成成果。</p> : <ul className="space-y-2">{scoped.map(document => <li key={document.id} className="break-words"><Link className="underline" href={`/knowledge/documents/${document.id}`}>{document.filename}</Link> · {document.collection} · 本地索引 {document.semantic?.lexicalCurrent === false ? "需更新" : "可用"} · 语义索引 {document.semantic?.indexed ?? 0}/{document._count.chunks}{!document.semantic?.modelRef ? "（未选择 embedding 模型）" : ""}</li>)}</ul>}
        {topic.config.collections.filter(name => !scoped.some(document => document.collection === name)).map(name => <p key={name} className="break-words text-muted-foreground">{name}：暂无文档</p>)}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>专题会话</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p>新会话使用专题资料范围和默认助理快照。会话内可以主动调整设置。</p><Button disabled={busy} onClick={() => void run(async signal => { const chat = await documentRequest<{ id: string }>(`${base}/conversations`, json("POST", { revision: topic.revision, title: `${topic.config.name} · 会话` }, signal)); if (!signal.aborted) openChat(chat.id); })}>开始专题会话</Button>
        {!chats.length ? <p>暂无专题会话。</p> : <ul className="space-y-1">{chats.map(chat => <li key={chat.id}><button className="break-words text-left underline" disabled={busy} onClick={() => openChat(chat.id)}>{chat.title}{chat.archived ? "（已归档）" : ""}</button></li>)}</ul>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>检索专题资料</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void run(async signal => { const value = await documentRequest<{ sources: DocumentSource[]; diagnostics: unknown }>(`${base}/search`, json("POST", { revision: topic.revision, query }, signal)); if (!signal.aborted) setEvidence(value); }); }}><Input className="min-w-0 flex-1" aria-label="专题检索问题" maxLength={2000} required value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /><Button disabled={busy} type="submit">检索专题</Button></form>
        <p className="text-xs text-muted-foreground">只检索专题集合；语义查询会使用当前 embedding 模型，可能产生费用。</p>
        {evidence ? <><DocumentSources sources={evidence.sources} />{!evidence.sources.length ? <p className="text-sm">没有足够的专题证据，请检查资料与索引。</p> : null}<RetrievalDiagnostics value={evidence.diagnostics} /></> : null}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>生成有引用的成果</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (confirmed) void run(generate); }}>
          <label className="block space-y-1 text-sm">成果标题<Input aria-label="成果标题" required maxLength={120} disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label className="block space-y-1 text-sm">成果类型<select aria-label="成果类型" className="w-full rounded-md border bg-background p-2" disabled={busy} value={kind} onChange={event => setKind(event.target.value as ArtifactInput["kind"])}><option value="summary">总结</option><option value="report">报告</option><option value="plan">方案</option></select></label>
          <label className="block space-y-1 text-sm">生成要求<Textarea aria-label="生成要求" required maxLength={2000} disabled={busy} value={brief} onChange={event => setBrief(event.target.value)} placeholder="说明需要解决的问题、适用条件和输出内容" /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label="确认模型调用" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />允许向已配置的检索和聊天模型发送问题与专题资料片段，可能产生费用。成果不使用个人记忆；引用内容仍需人工核对。</label>
          <div className="flex flex-wrap gap-2"><Button disabled={busy || !confirmed || !scoped.length} type="submit">生成成果</Button>{generating ? <Button variant="outline" type="button" onClick={() => { operation.current?.abort(); setNotice("已取消请求；已发出的模型调用可能产生费用。请刷新成果查看保存状态，不会自动重新生成。"); }}>取消生成</Button> : null}</div>
        </form>
        <p className="text-xs text-muted-foreground">生成失败、中断或断线后，请刷新查看已有记录。再次点击生成会创建新的请求。</p>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>成果历史</CardTitle></CardHeader><CardContent className="space-y-3">
        {!artifacts.length ? <p className="text-sm">暂无成果。</p> : <ul className="space-y-2">{artifacts.map(item => <li key={item.id}><button disabled={busy} className="break-words text-left text-sm underline" onClick={() => void openArtifact(item.id)}>{item.title} · {statuses[item.status]}</button></li>)}</ul>}
        {selected ? <article className="min-w-0 space-y-3 rounded-lg border p-3"><h2 className="break-words font-semibold">{selected.title}</h2><p className="text-sm">{statuses[selected.status]}{selected.errorCode ? ` · ${selected.errorCode}` : ""} · 专题版本 {selected.topicRevision}{selected.topicRevision !== topic.revision ? "（使用旧专题设置）" : ""}</p>
          <p className="break-words text-xs text-muted-foreground">生成模型：{selected.metadata.responseModelId ?? selected.metadata.model?.modelId ?? "未调用"} · 生成时资料集合：{selected.metadata.topic.collections.join("、")}</p>
          {selected.status === "needs_review" ? <p role="alert" className="text-sm text-warning">正文未引用提供的资料，或包含未识别的链接，请检查后再使用。</p> : null}
          {selected.content ? <><MarkdownMessage text={selected.content} /><p className="text-xs text-muted-foreground">链接存在不代表事实已验证。下面保留生成时的资料快照，并检查当前资料版本。</p><div className="flex flex-wrap gap-3 text-sm"><a className="underline" href={`${base}/artifacts/${selected.id}/export?format=markdown`}>导出 Markdown</a><a className="underline" href={`${base}/artifacts/${selected.id}/export?format=json`}>导出 JSON 与引用快照</a></div></> : null}
          <DocumentSources sources={selected.metadata.sources} /><RetrievalDiagnostics value={selected.metadata.diagnostics} />
          <Button disabled={busy || selected.status === "generating"} variant="outline" onClick={() => { if (window.confirm("删除这条成果记录及其引用快照？资料文档会保留。")) void run(async signal => { await documentRequest(`${base}/artifacts/${selected.id}?confirm=true`, { method: "DELETE", signal }); if (!signal.aborted) { setSelected(null); pending.current = null; await load(signal); } }); }}>删除成果</Button>
        </article> : null}
      </CardContent></Card>
      <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("删除专题及全部成果？资料和会话会保留，会话将解除专题关联。")) void run(async signal => { await documentRequest(`${base}?confirm=true&revision=${topic.revision}`, { method: "DELETE", signal }); if (!signal.aborted) router.push("/topics"); }); }}>删除专题</Button>
    </> : null}
  </main>;
}
