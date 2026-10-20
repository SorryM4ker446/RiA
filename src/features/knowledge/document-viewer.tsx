"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Download, Loader2, PencilLine } from "lucide-react";
import { documentRequest } from "@/features/knowledge/document-client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { downloadBlob } from "@/lib/download-blob";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { exportFilename, formatLabels, type ExportFormat, type ProcessedDocument } from "@/lib/document-processor/schema";

type DocumentView = { contentHash: string; filename: string; chunks: { id: string; text: string; ordinal: number; pageNumber: number | null }[] };
export function DocumentViewer({ id, version }: { id: string; version?: string }) {
  useLocale();
  const [document, setDocument] = useState<DocumentView | null>(null);
  const [error, setError] = useState("");
  const [outdated, setOutdated] = useState(false);
  const [draft, setDraft] = useState<ProcessedDocument | null>(null);
  const [view, setView] = useState("source");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  async function run(kind: string, action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(kind); setActionError("");
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : t("ui.knowledge.document-viewer.documentOperationFailedPleaseTryAgain")); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(""); } }
  }
  function edit() {
    if (draft) { setView("edit"); return; }
    void run("load", async signal => {
      const next = await documentRequest<ProcessedDocument>(`/api/document-processor/source/${encodeURIComponent(id)}`, { signal });
      if (signal.aborted) return;
      if (next.source?.contentHash !== document?.contentHash) throw new Error(t("ui.knowledge.document-viewer.documentUpdatedRefreshDetailsBeforeEditing"));
      setDraft(next); setView("edit");
    });
  }
  function updateDraft(change: Partial<ProcessedDocument>) {
    setDraft(current => current ? { ...current, ...change } : current);
    setHtml("");
  }
  async function exportCopy(format: ExportFormat, signal: AbortSignal) {
    const response = await fetch("/api/document-processor/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: draft!.filename, content: draft!.content, syntax: draft!.syntax, format }), signal });
    if (!response.ok) throw new Error(getApiErrorMessage(await response.json(), t("ui.knowledge.document-viewer.documentExportFailed")));
    return response;
  }
  function download(format: ExportFormat) {
    void run("export", async signal => {
      const editing = view !== "source" && draft;
      const response = editing ? await exportCopy(format, signal) : await fetch(`/api/documents/${encodeURIComponent(id)}/export?format=${format}&version=${document!.contentHash}`, { signal });
      if (!response.ok) throw new Error(getApiErrorMessage(await response.json(), t("ui.knowledge.document-viewer.documentExportFailed")));
      const blob = await response.blob();
      if (!signal.aborted) downloadBlob(blob, exportFilename(editing ? draft!.filename : document!.filename, format));
    });
  }
  function changeView(next: string) {
    setView(next);
    if (next === "preview" && !html) void run("preview", async signal => {
      const value = await (await exportCopy("html", signal)).text();
      if (!signal.aborted) setHtml(value);
    });
  }
  useEffect(() => {
    const controller = new AbortController();
    documentRequest<DocumentView>(`/api/documents/${encodeURIComponent(id)}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setDocument(value);
      const chunkId = window.location.hash.slice(1);
      setOutdated(Boolean((version && version !== value.contentHash) || (chunkId && !value.chunks.some(chunk => chunk.id === chunkId))));
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [id, version]);
  useEffect(() => {
    if (!document) return;
    const checkHash = () => {
      const chunkId = window.location.hash.slice(1);
      setOutdated(Boolean((version && version !== document.contentHash) || (chunkId && !document.chunks.some(chunk => chunk.id === chunkId))));
      if (document.chunks.some(chunk => chunk.id === chunkId)) setView("source");
      const element = window.document.getElementById(chunkId);
      if (element) element.scrollIntoView({ block: "center" });
    };
    window.addEventListener("hashchange", checkHash);
    if (window.location.hash) window.document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "center" });
    return () => window.removeEventListener("hashchange", checkHash);
  }, [document, version]);
  useEffect(() => {
    if (view === "source" && window.location.hash) window.document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [view, document]);
  const editing = view !== "source";
  const ready = !!document && !busy && (!editing || !!draft?.content.trim() && !!draft.filename.trim());
  return <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
    <Link className="text-sm text-muted-foreground transition-colors hover:text-foreground" href="/knowledge">{t("documents.backToLibrary")}</Link>
    <h1 className="break-all text-xl font-semibold tracking-headline">{document?.filename ?? t("documents.fallbackTitle")}</h1>
    <p className="text-sm leading-6 text-muted-foreground">{t("documents.extractedTextNote")}</p>
    {document && <div className="flex flex-wrap items-center gap-2" aria-label={t("ui.knowledge.document-viewer.documentActions")}>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => editing ? setView("source") : edit()}>
        {busy === "load" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : editing ? <ArrowLeft data-icon="inline-start" /> : <PencilLine data-icon="inline-start" />}
        {editing ? t("ui.knowledge.document-viewer.backToOriginal") : draft ? t("ui.knowledge.document-viewer.continueEditingCopy") : t("ui.knowledge.document-viewer.editCopy")}
      </Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={!ready} aria-label={editing ? t("ui.knowledge.document-viewer.exportCopy") : t("conversationRow.export")}>
        {busy === "export" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}{editing ? t("ui.knowledge.document-viewer.exportCopy") : t("conversationRow.export")}<ChevronDown data-icon="inline-end" />
      </Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup>
        {(["docx", "md", "txt", "html"] as const).map(format => <DropdownMenuItem key={format} data-document-export={format} onSelect={() => download(format)}>{formatLabels[format]} · .{format}</DropdownMenuItem>)}
      </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
      {busy && <Button size="sm" variant="ghost" onClick={() => { operation.current?.abort(); }}>{t("backups.cancelAction")}</Button>}
    </div>}
    {actionError && <Alert variant="destructive"><AlertDescription>{actionError}</AlertDescription></Alert>}
    {error ? <p role="alert" className="text-destructive">{localizeMessage(error)}</p> : !document ? <p>{t("documents.loading")}</p> : null}
    {outdated ? <p className="text-sm text-muted-foreground" role="status">{t("documents.outdated")}</p> : null}
    {editing && draft ? <section aria-label={t("ui.knowledge.document-viewer.documentCopyEditor")} className="flex min-w-0 flex-col gap-3">
      <Tabs value={view} onValueChange={changeView}>
        <TabsList><TabsTrigger value="edit" disabled={!!busy}>{t("ui.knowledge.document-viewer.editContent")}</TabsTrigger><TabsTrigger value="preview" disabled={!ready}>{t("ui.knowledge.document-viewer.layoutPreview")}</TabsTrigger></TabsList>
        <TabsContent value="edit" className="pt-3"><Field>
          <FieldLabel htmlFor="document-copy-content" className="sr-only">{t("ui.knowledge.document-viewer.documentContent")}</FieldLabel>
          <Textarea id="document-copy-content" value={draft.content} disabled={!!busy} maxLength={100_000} rows={16} className="chat-list-scroll min-h-64 resize-y font-mono leading-7 sm:min-h-96" onChange={event => updateDraft({ content: event.target.value })} />
          <FieldDescription>{t("ui.knowledge.document-viewer.thisCopyIsForPreviewAnd")}</FieldDescription>
        </Field></TabsContent>
        <TabsContent value="preview" className="pt-3">{html ? <iframe title={t("ui.knowledge.document-viewer.documentLayoutPreview")} sandbox="" srcDoc={html} className="h-[28rem] w-full rounded-lg bg-background" /> : <div role="status" className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">{busy ? <><Loader2 className="size-4 animate-spin" />{t("ui.knowledge.document-viewer.generatingPreview")}</> : <Button variant="outline" size="sm" onClick={() => changeView("preview")}>{t("ui.knowledge.document-viewer.regeneratePreview")}</Button>}</div>}</TabsContent>
      </Tabs>
      <details className="rounded-lg border px-3 py-2">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("ui.knowledge.document-viewer.exportOptions")}</summary>
        <FieldGroup className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field><FieldLabel htmlFor="document-copy-name">{t("ui.knowledge.document-viewer.filename")}</FieldLabel><Input id="document-copy-name" value={draft.filename} disabled={!!busy} maxLength={180} onChange={event => updateDraft({ filename: event.target.value })} /></Field>
          <Field><FieldLabel htmlFor="document-copy-syntax">{t("ui.knowledge.document-viewer.contentType")}</FieldLabel><SelectField id="document-copy-syntax" value={draft.syntax} disabled={!!busy} onValueChange={syntax => { updateDraft({ syntax: syntax as "plain" | "markdown" }); setView("edit"); }}><SelectOption value="markdown">{t("ui.knowledge.document-viewer.markdownStructure")}</SelectOption><SelectOption value="plain">{t("ui.knowledge.document-viewer.plainText")}</SelectOption></SelectField></Field>
        </FieldGroup>
        <p className="mt-3 text-xs text-muted-foreground">{t("ui.knowledge.document-viewer.conversionUsesExtractedTextStructureOriginal")}</p>
      </details>
    </section> : document?.chunks.map(chunk => <section className="scroll-mt-6 rounded-lg bg-card p-4 shadow-hairline target:ring-2 target:ring-ring/70" id={chunk.id} key={chunk.id}>
      <h2 className="label-mono mb-2">{t("documents.chunkLabel")} {chunk.ordinal + 1}{chunk.pageNumber ? ` · ${t("documents.pageLabel")} ${chunk.pageNumber} ${t("documents.pageUnit")}` : ""}</h2>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{chunk.text}</p>
    </section>)}
  </main>;
}
