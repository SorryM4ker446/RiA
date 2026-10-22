"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";
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
import { animateRemoval, removalKey } from "@/lib/ui/removal";

type Conversation = { id: string; title: string; archived: boolean };
const statuses = (): Record<ArtifactSummary["status"], string> => ({ generating: t("chat.toolbar.statusGenerating"), ready: t("ui.topics.topic-workspace.generated"), needs_review: t("ui.topics.topic-workspace.citationsNeedReview"), failed: t("mediaGen.failedShortSuffix"), cancelled: t("models.statusAborted"), interrupted: t("ui.topics.topic-workspace.interrupted") });
export function TopicWorkspace({ topicId }: { topicId: string }) {
  useLocale();
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
    try { await action(controller.signal); } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : t("ui.topics.topic-workspace.operationFailedRefreshToSeeSaved")); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); setGenerating(false); setLoading(false); } }
  }
  async function refresh(signal: AbortSignal) {
    await load(signal);
    const id = pending.current ?? selected?.id;
    if (id) {
      try { const item = await documentRequest<ArtifactDetail>(`${base}/artifacts/${id}`, { signal }); if (!signal.aborted) { setSelected(item); pending.current = null; } }
      catch (error) { if (error instanceof DocumentRequestError && error.status === 404) { pending.current = null; setSelected(null); setNotice(t("ui.topics.topic-workspace.artifactRecordNotFoundCheckThe")); } else throw error; }
    }
  }
  async function openArtifact(id: string) {
    selection.current?.abort(); const controller = new AbortController(); selection.current = controller;
    try { const item = await documentRequest<ArtifactDetail>(`${base}/artifacts/${id}`, { signal: controller.signal }); if (!controller.signal.aborted && selection.current === controller) setSelected(item); }
    catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : t("ui.topics.topic-workspace.couldNotLoadArtifact")); }
    finally { if (selection.current === controller) selection.current = null; }
  }
  function openChat(id: string) { try { localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, id); } catch { setNotice(t("ui.topics.topic-workspace.theBrowserCannotSaveTheConversation")); return; } router.push("/chat"); }
  async function save(config: TopicConfig) { await run(async signal => {
    await documentRequest(base, json("PATCH", { revision: topic!.revision, ...config }, signal));
    if (!signal.aborted) { setEditing(false); setEvidence(null); setNotice(t("ui.topics.topic-workspace.topicSavedExistingConversationsAndArtifacts"));
      try { await load(signal); } catch (error) { if (!signal.aborted) setNotice(tf("ui.topics.topic-workspace.topicSavedButRefreshingThePage", { v0: error instanceof Error ? error.message : "" })); }
    }
  }); }
  async function generate(signal: AbortSignal) {
    const requestId = crypto.randomUUID(); pending.current = requestId; setGenerating(true); selection.current?.abort(); setSelected(null);
    const item = await documentRequest<ArtifactDetail>(`${base}/artifacts`, json("POST", { confirm: true, requestId, revision: topic!.revision, title, kind, brief }, signal));
    if (!signal.aborted) { pending.current = null; setSelected(item); setConfirmed(false); setGenerating(false);
      try { await load(signal); } catch (error) { if (!signal.aborted) setNotice(tf("ui.topics.topic-workspace.artifactRecordSavedButRefreshingThe", { v0: error instanceof Error ? error.message : "" })); }
    }
  }
  if (loading) return <main className="p-4">{t("ui.topics.loadingTopics")}</main>;
  const scoped = docs.filter(document => topic?.config.collections.includes(document.collection ?? ""));
  return <main className="mx-auto max-w-5xl space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="break-words text-xl font-semibold">{topic?.config.name ?? t("ui.backups.knowledgeTopics")}</h1><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>{t("ui.topics.topic-workspace.refreshTopicAndArtifacts")}</Button><Link className="self-center text-sm underline" href="/topics">{t("ui.topics.topic-workspace.allTopics")}</Link></div></div>
    {notice ? <p role="status" className="break-words rounded-lg border p-3 text-sm">{localizeMessage(notice)}</p> : null}
    {topic ? <>
      <p className="break-words text-sm text-muted-foreground">{topic.config.description} {t("ui.topics.topic-workspace.topicVersion")}{topic.revision}</p>
      <Card><CardHeader><CardTitle>{t("ui.topics.topic-workspace.knowledgeDefaults")}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p className="break-words">{t("ui.topics.topic-workspace.collections")}{topic.config.collections.join("、")}</p><p>{t("ui.topics.topic-workspace.defaultAssistant")}{assistants.find(item => item.id === topic.config.assistantTemplateId)?.config.name ?? (topic.config.assistantTemplateId ? t("ui.topics.topic-workspace.originalTemplateUnavailableUpdateSettings") : t("ui.topics.topic-workspace.currentDefaultChatModel"))}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => setEditing(value => !value)}>{t("ui.topics.topic-workspace.editTopicSettings")}</Button><Link className="self-center underline" href="/knowledge">{t("ui.topics.topic-workspace.manageDocumentsIndexes")}</Link></div>
        {editing ? <TopicEditor key={`${topic.id}:${topic.revision}`} initial={topic.config} assistants={assistants} collections={[...new Set(docs.flatMap(document => document.collection ? [document.collection] : []))]} busy={busy} save={save} cancel={() => setEditing(false)} /> : null}
        {!scoped.length ? <p>{t("ui.topics.topic-workspace.theseCollectionsHaveNoDocumentsImport")}</p> : <ul className="space-y-2">{scoped.map(document => <li key={document.id} className="break-words"><Link className="underline" href={`/knowledge/documents/${document.id}`}>{document.filename}</Link> · {document.collection} {t("ui.topics.topic-workspace.localIndex")}{document.semantic?.lexicalCurrent === false ? t("ui.topics.topic-workspace.needsUpdating") : t("models.availability.ready")} {tf("ui.topics.topic-workspace.semanticIndex", { indexed: document.semantic?.indexed ?? 0, total: document._count.chunks })}{!document.semantic?.modelRef ? t("ui.topics.topic-workspace.noEmbeddingModelSelected") : ""}</li>)}</ul>}
        {topic.config.collections.filter(name => !scoped.some(document => document.collection === name)).map(name => <p key={name} className="break-words text-muted-foreground">{name}{t("ui.topics.topic-workspace.noDocuments")}</p>)}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t("ui.topics.topic-workspace.topicConversations")}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p>{t("ui.topics.topic-workspace.newConversationsUseTheTopicS")}</p><Button disabled={busy} onClick={() => void run(async signal => { const chat = await documentRequest<{ id: string }>(`${base}/conversations`, json("POST", { revision: topic.revision, title: tf("ui.topics.topic-workspace.conversation", { v0: topic.config.name }) }, signal)); if (!signal.aborted) openChat(chat.id); })}>{t("ui.topics.topic-workspace.startTopicConversation")}</Button>
        {!chats.length ? <p>{t("ui.topics.topic-workspace.noTopicConversationsYet")}</p> : <ul className="space-y-1">{chats.map(chat => <li key={chat.id}><button className="break-words text-left underline" disabled={busy} onClick={() => openChat(chat.id)}>{chat.title}{chat.archived ? t("ui.topics.topic-workspace.archived") : ""}</button></li>)}</ul>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t("ui.topics.topic-workspace.searchTopicKnowledge")}</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void run(async signal => { const value = await documentRequest<{ sources: DocumentSource[]; diagnostics: unknown }>(`${base}/search`, json("POST", { revision: topic.revision, query }, signal)); if (!signal.aborted) setEvidence(value); }); }}><Input className="min-w-0 flex-1" aria-label={t("ui.topics.topic-workspace.topicSearchQuestion")} maxLength={2000} required value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /><Button disabled={busy} type="submit">{t("ui.topics.topic-workspace.searchTopic")}</Button></form>
        <p className="text-xs text-muted-foreground">{t("ui.topics.topic-workspace.searchesOnlyTopicCollectionsSemanticQueries")}</p>
        {evidence ? <><DocumentSources sources={evidence.sources} />{!evidence.sources.length ? <p className="text-sm">{t("ui.topics.topic-workspace.insufficientTopicEvidenceCheckDocumentsAnd")}</p> : null}<RetrievalDiagnostics value={evidence.diagnostics} /></> : null}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t("ui.topics.topic-workspace.generateCitedArtifact")}</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (confirmed) void run(generate); }}>
          <label className="block space-y-1 text-sm">{t("ui.topics.topic-workspace.artifactTitle")}<Input aria-label={t("ui.topics.topic-workspace.artifactTitle")} required maxLength={120} disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label className="block space-y-1 text-sm">{t("ui.topics.topic-workspace.artifactType")}<SelectField aria-label={t("ui.topics.topic-workspace.artifactType")} className="w-full rounded-md border bg-background p-2" disabled={busy} value={kind} onValueChange={value => setKind(value as ArtifactInput["kind"])}><SelectOption value="summary">{t("ui.topics.topic-workspace.summary")}</SelectOption><SelectOption value="report">{t("ui.topics.topic-workspace.report")}</SelectOption><SelectOption value="plan">{t("ui.topics.topic-workspace.plan")}</SelectOption></SelectField></label>
          <label className="block space-y-1 text-sm">{t("ui.topics.topic-workspace.generationInstructions")}<Textarea aria-label={t("ui.topics.topic-workspace.generationInstructions")} required maxLength={2000} disabled={busy} value={brief} onChange={event => setBrief(event.target.value)} placeholder={t("ui.topics.topic-workspace.describeTheProblemConditionsAndDesired")} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" aria-label={t("ui.topics.topic-workspace.confirmModelCall")} disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("ui.topics.topic-workspace.allowSendingQuestionsAndTopicExcerpts")}</label>
          <div className="flex flex-wrap gap-2"><Button disabled={busy || !confirmed || !scoped.length} type="submit">{t("ui.topics.topic-workspace.generateArtifact")}</Button>{generating ? <Button variant="outline" type="button" onClick={() => { operation.current?.abort(); setNotice(t("ui.topics.topic-workspace.requestCancelledModelCallsAlreadySent")); }}>{t("ui.topics.topic-workspace.cancelGeneration")}</Button> : null}</div>
        </form>
        <p className="text-xs text-muted-foreground">{t("ui.topics.topic-workspace.afterFailureInterruptionOrDisconnectionRefresh")}</p>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t("ui.topics.topic-workspace.artifactHistory")}</CardTitle></CardHeader><CardContent className="space-y-3">
        {!artifacts.length ? <p className="text-sm">{t("ui.topics.topic-workspace.noArtifactsYet")}</p> : <ul className="space-y-2">{artifacts.map(item => <li key={item.id} {...removalKey(item.id)}><button disabled={busy} className="break-words text-left text-sm underline" onClick={() => void openArtifact(item.id)}>{item.title} · {statuses()[item.status]}</button></li>)}</ul>}
        {selected ? <article className="min-w-0 space-y-3 rounded-lg border p-3"><h2 className="break-words font-semibold">{selected.title}</h2><p className="text-sm">{statuses()[selected.status]}{selected.errorCode ? ` · ${selected.errorCode}` : ""} {t("ui.topics.topic-workspace.topicVersion")}{selected.topicRevision}{selected.topicRevision !== topic.revision ? t("ui.topics.topic-workspace.usesPreviousTopicSettings") : ""}</p>
          <p className="break-words text-xs text-muted-foreground">{t("ui.topics.topic-workspace.generationModel")}{selected.metadata.responseModelId ?? selected.metadata.model?.modelId ?? t("ui.topics.topic-workspace.notCalled")} {t("ui.topics.topic-workspace.collectionsAtGeneration")}{selected.metadata.topic.collections.join("、")}</p>
          {selected.status === "needs_review" ? <p role="alert" className="text-sm text-warning">{t("ui.topics.topic-workspace.theTextDidNotCiteSupplied")}</p> : null}
          {selected.content ? <><MarkdownMessage text={selected.content} /><p className="text-xs text-muted-foreground">{t("ui.topics.topic-workspace.aLinkDoesNotEstablishFactual")}</p><div className="flex flex-wrap gap-3 text-sm"><a className="underline" href={`${base}/artifacts/${selected.id}/export?format=markdown`}>{t("ui.topics.topic-workspace.exportMarkdown")}</a><a className="underline" href={`${base}/artifacts/${selected.id}/export?format=json`}>{t("ui.topics.topic-workspace.exportJSONWithCitationSnapshots")}</a></div></> : null}
          <DocumentSources sources={selected.metadata.sources} /><RetrievalDiagnostics value={selected.metadata.diagnostics} />
          <Button disabled={busy || selected.status === "generating"} variant="outline" onClick={() => { if (window.confirm(t("ui.topics.topic-workspace.deleteThisArtifactAndItsCitation"))) void run(async signal => { await documentRequest(`${base}/artifacts/${selected.id}?confirm=true`, { method: "DELETE", signal }); if (!signal.aborted) { const removed = selected.id; setSelected(null); pending.current = null; await animateRemoval(removed, () => load(signal)); } }); }}>{t("ui.topics.topic-workspace.deleteArtifact")}</Button>
        </article> : null}
      </CardContent></Card>
      <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm(t("ui.topics.topic-workspace.deleteThisTopicAndAllArtifacts"))) void run(async signal => { await documentRequest(`${base}?confirm=true&revision=${topic.revision}`, { method: "DELETE", signal }); if (!signal.aborted) router.push("/topics"); }); }}>{t("ui.topics.topic-workspace.deleteTopic")}</Button>
    </> : null}
  </main>;
}
