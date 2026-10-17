"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Download, FileText, FolderOpen, Loader2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { downloadBlob } from "@/lib/download-blob";
import { exportFilename, exportFormats, formatLabels, type ExportFormat, type ContentSyntax, type ProcessedDocument } from "@/lib/document-processor/schema";

type LibraryDocument = { id: string; filename: string; collection: string | null };
async function api<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, "文档处理失败。"));
  return payload.data;
}

export function DocumentWorkspace({ initialDocumentId }: { initialDocumentId?: string }) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [selectedId, setSelectedId] = useState(initialDocumentId ?? "");
  const [document, setDocument] = useState<ProcessedDocument | null>(null);
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("");
  const [syntax, setSyntax] = useState<ContentSyntax>("markdown");
  const [format, setFormat] = useState<ExportFormat>("docx");
  const [tab, setTab] = useState("edit");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const applyDocument = useCallback((next: ProcessedDocument) => {
    setDocument(next); setContent(next.content); setFilename(next.filename); setSyntax(next.syntax); setHtml(""); setTab("edit");
  }, []);
  const loadLibrary = useCallback(async () => {
    libraryRequest.current?.abort(); const controller = new AbortController(); libraryRequest.current = controller;
    setLibraryLoading(true); setLibraryError("");
    try { const items = await api<LibraryDocument[]>("/api/documents", { signal: controller.signal }); if (!controller.signal.aborted) setDocuments(items); }
    catch (failure) { if (!controller.signal.aborted) setLibraryError(failure instanceof Error ? failure.message : "文档列表加载失败。"); }
    finally { if (!controller.signal.aborted) setLibraryLoading(false); }
  }, []);
  const run = useCallback(async (kind: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(kind); setError(""); setNotice("");
    try { await action(controller.signal); }
    catch (failure) {
      if (alive.current && operation.current === controller) {
        if (controller.signal.aborted) setNotice("操作已取消，当前内容保留。");
        else setError(failure instanceof Error ? failure.message : "文档处理失败。");
      }
    } finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(""); } }
  }, []);
  useEffect(() => {
    alive.current = true; void loadLibrary();
    return () => { alive.current = false; libraryRequest.current?.abort(); operation.current?.abort(); operation.current = null; };
  }, [loadLibrary]);
  useEffect(() => {
    if (!initialDocumentId) return;
    operation.current?.abort(); operation.current = null; setSelectedId(initialDocumentId);
    void run("load", async signal => { const next = await api<ProcessedDocument>(`/api/document-processor/source/${encodeURIComponent(initialDocumentId)}`, { signal }); if (!signal.aborted) applyDocument(next); });
  }, [initialDocumentId, applyDocument, run]);

  function canReplace() {
    return !document || (content === document.content && filename === document.filename && syntax === document.syntax) || window.confirm("替换当前编辑内容？请先确认已下载需要保留的版本。");
  }
  function upload(file: File | undefined) {
    if (!file || !canReplace()) return;
    void run("parse", async signal => {
      const body = new FormData(); body.set("file", file);
      const next = await api<ProcessedDocument>("/api/document-processor/parse", { method: "POST", body, signal });
      if (!signal.aborted) { applyDocument(next); setNotice("解析完成，可以编辑内容或选择格式导出。"); }
    });
  }
  async function exportRequest(target: ExportFormat, signal: AbortSignal) {
    const response = await fetch("/api/document-processor/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename, content, syntax, format: target }), signal });
    if (!response.ok) throw new Error(getApiErrorMessage(await response.json(), "文档导出失败。"));
    return response;
  }
  function selectTab(next: string) {
    setTab(next);
    if (next === "preview" && !html) void run("preview", async signal => {
      const response = await exportRequest("html", signal), value = await response.text();
      if (!signal.aborted) setHtml(value);
    });
  }
  function download() {
    void run("download", async signal => {
      const response = await exportRequest(format, signal), blob = await response.blob();
      if (signal.aborted) return;
      downloadBlob(blob, exportFilename(filename, format));
      setNotice(`已生成 ${formatLabels[format]} 下载副本。`);
    });
  }
  const ready = !!document && !!content.trim() && !!filename.trim() && !busy;
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
    <header className="workspace-page-header"><div className="flex flex-col gap-2"><h1>文档处理器</h1><p className="text-sm text-muted-foreground">在本机解析文件，整理内容，再导出需要的格式。</p></div><Badge variant="outline">本机处理 · 无需模型</Badge></header>
    {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card><CardHeader><CardTitle>选择文档</CardTitle><CardDescription>支持 PDF、Word、Markdown 和 TXT，单文件不超过 8 MiB。</CardDescription></CardHeader><CardContent>
          <Tabs defaultValue="upload"><TabsList className="w-full"><TabsTrigger value="upload" disabled={!!busy}>本地文件</TabsTrigger><TabsTrigger value="library" disabled={!!busy}>知识库</TabsTrigger></TabsList>
            <TabsContent value="upload" className="pt-4"><div className="flex flex-col gap-3"><input ref={fileInput} className="sr-only" type="file" accept=".pdf,.docx,.md,.txt" aria-label="选择待处理文档" disabled={!!busy} onChange={event => { upload(event.target.files?.[0]); event.target.value = ""; }} /><Button variant="outline" disabled={!!busy} onClick={() => fileInput.current?.click()}><Upload data-icon="inline-start" />选择文件</Button><p className="text-xs leading-5 text-muted-foreground">提取结果可直接编辑，下载你确认后的内容。</p></div></TabsContent>
            <TabsContent value="library" className="pt-4"><FieldGroup className="gap-3"><Field><FieldLabel htmlFor="processor-source">知识库文档</FieldLabel><SelectField id="processor-source" value={selectedId} disabled={!!busy || libraryLoading} onValueChange={setSelectedId}><SelectOption value="">选择文档</SelectOption>{documents.map(item => <SelectOption key={item.id} value={item.id}>{item.filename}{item.collection ? ` · ${item.collection}` : ""}</SelectOption>)}</SelectField></Field>{libraryLoading && <Skeleton className="h-5" />}{libraryError && <p role="alert" className="text-xs text-destructive">{libraryError}</p>}{!libraryLoading && !libraryError && !documents.length && <FieldDescription>知识库中还没有文档。<Link href="/knowledge" className="underline underline-offset-4">去导入</Link></FieldDescription>}<div className="flex gap-2"><Button size="sm" variant="outline" disabled={!selectedId || !!busy || libraryLoading} onClick={() => { if (canReplace()) void run("load", async signal => { const next = await api<ProcessedDocument>(`/api/document-processor/source/${encodeURIComponent(selectedId)}`, { signal }); if (!signal.aborted) applyDocument(next); }); }}><FolderOpen data-icon="inline-start" />读取</Button><Button size="icon-sm" variant="ghost" aria-label="刷新文档列表" disabled={!!busy || libraryLoading} onClick={() => void loadLibrary()}><RefreshCw /></Button></div></FieldGroup></TabsContent>
          </Tabs>
        </CardContent><CardFooter><p className="text-xs text-muted-foreground">也可以直接粘贴文字开始整理。</p></CardFooter></Card>
        <Card><CardHeader><CardTitle>导出设置</CardTitle><CardDescription>下载当前编辑内容的副本。</CardDescription></CardHeader><CardContent><FieldGroup className="gap-4">
          <Field><FieldLabel htmlFor="processor-name">文件名称</FieldLabel><Input id="processor-name" value={filename} disabled={!document || !!busy} maxLength={180} onChange={event => { setFilename(event.target.value); setHtml(""); }} placeholder="文档名称" /></Field>
          <Field><FieldLabel htmlFor="processor-syntax">内容类型</FieldLabel><SelectField id="processor-syntax" value={syntax} disabled={!document || !!busy} onValueChange={value => { setSyntax(value as ContentSyntax); setHtml(""); setTab("edit"); }}><SelectOption value="markdown">Markdown 结构</SelectOption><SelectOption value="plain">纯文本</SelectOption></SelectField><FieldDescription>纯文本保留原有符号；Markdown 可排版标题、列表和表格。</FieldDescription></Field>
          <Field><FieldLabel htmlFor="processor-format">导出格式</FieldLabel><SelectField id="processor-format" value={format} disabled={!document || !!busy} onValueChange={value => setFormat(value as ExportFormat)}>{exportFormats.map(value => <SelectOption key={value} value={value}>{formatLabels[value]} · .{value}</SelectOption>)}</SelectField></Field>
        </FieldGroup></CardContent><CardFooter><Button className="w-full" disabled={!ready} onClick={download}>{busy === "download" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}下载 {formatLabels[format]}</Button></CardFooter></Card>
      </div>
      <Card className="min-w-0"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{document ? "内容与预览" : "准备处理文档"}</CardTitle>{document && <Badge variant="secondary">{content.length.toLocaleString()} 字符{document.format === "pdf" ? ` · ${document.pages.length} 页` : ""}</Badge>}</div><CardDescription>{document ? document.filename : "上传本地文件、读取知识库文档，或新建一份内容。"}</CardDescription></CardHeader><CardContent className="min-w-0">
        {busy === "parse" || busy === "load" ? <div className="flex min-h-96 flex-col items-center justify-center gap-4" role="status"><Loader2 className="size-6 animate-spin text-muted-foreground" /><p className="text-sm text-muted-foreground">正在读取文档…</p></div> : !document ? <Empty className="min-h-96"><EmptyHeader><EmptyMedia><FileText /></EmptyMedia><EmptyTitle>从一份文档开始</EmptyTitle><EmptyDescription>解析过程在本机完成；扫描 PDF 需要先做 OCR。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => applyDocument({ filename: "未命名文档.md", format: "md", syntax: "markdown", pages: [], content: "", characterCount: 0, contentHash: "", notes: [] })}>新建内容</Button></Empty> : <Tabs value={tab} onValueChange={selectTab}><TabsList><TabsTrigger value="edit" disabled={!!busy}>编辑内容</TabsTrigger><TabsTrigger value="preview" disabled={!ready}>版式预览</TabsTrigger></TabsList><TabsContent value="edit" className="pt-4"><Field><FieldLabel htmlFor="processor-content" className="sr-only">文档内容</FieldLabel><Textarea id="processor-content" value={content} disabled={!!busy} maxLength={100_000} className="chat-list-scroll min-h-[30rem] resize-y font-mono leading-7" onChange={event => { setContent(event.target.value); setHtml(""); }} /><FieldDescription>最多 100,000 字符。可在此调整内容后再导出。</FieldDescription></Field></TabsContent><TabsContent value="preview" className="pt-4">{busy === "preview" ? <Skeleton className="h-[30rem]" /> : html ? <iframe title="文档版式预览" sandbox="" srcDoc={html} className="h-[36rem] w-full rounded-lg bg-background" /> : <div className="flex min-h-96 flex-col items-center justify-center gap-3"><p className="text-sm text-muted-foreground">预览尚未生成。</p><Button variant="outline" disabled={!ready} onClick={() => selectTab("preview")}>重新生成预览</Button></div>}</TabsContent></Tabs>}
      </CardContent><CardFooter className="flex flex-col items-start gap-2">{busy && <Button size="sm" variant="outline" onClick={() => operation.current?.abort()}>取消操作</Button>}<p className="text-xs leading-5 text-muted-foreground">转换保留提取后的文本结构，原版式、图片、页眉页脚和合并单元格可能丢失。外部图片不会自动下载。</p></CardFooter></Card>
    </div>
  </main>;
}
