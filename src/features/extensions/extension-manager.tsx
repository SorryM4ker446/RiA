"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, Check, ChevronRight, Loader2, Plus, Power, Puzzle, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { ExtensionView } from "@/lib/extensions/store";
import type { ToolCatalogItem } from "@/features/chat/types";
import { ExtensionEditor } from "./extension-editor";
import { ExtensionDiscovery } from "./extension-discovery";
import type { RegistryConnectionDraft } from "@/lib/extensions/registry-types";

type ExtensionData = { items: ExtensionView[]; encryptionAvailable: boolean; localProcessesAllowed: boolean };
async function request<T>(url: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", signal, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, "扩展操作失败。"));
  return payload.data;
}
const labels = { "mcp-http": "MCP · 远程", "mcp-stdio": "MCP · 本地", http: "HTTP API" };
function connectionLabel(row: ExtensionView) { return row.config.type === "mcp-stdio" ? row.config.command : row.config.url; }
function stateLabel(row: ExtensionView) { return !row.credentialsAvailable ? "凭据不可用" : row.error ? "连接失败" : row.enabled ? "已启用" : row.tested ? "已停用" : "待检测"; }

export function ExtensionManager() {
  const [data, setData] = useState<ExtensionData>({ items: [], encryptionAvailable: false, localProcessesAllowed: false });
  const [builtins, setBuiltins] = useState<ToolCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editor, setEditor] = useState<ExtensionView | "new" | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSession, setEditorSession] = useState(0);
  const [toolSheet, setToolSheet] = useState<ExtensionView | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsSession, setToolsSession] = useState(0);
  const [tab, setTab] = useState("mine");
  const [registryDraft, setRegistryDraft] = useState<RegistryConnectionDraft | undefined>();
  const opener = useRef<HTMLElement | null>(null);
  const operation = useRef<AbortController | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const load = useCallback(async (clearError = true) => {
    loadRequest.current?.abort(); const controller = new AbortController(); loadRequest.current = controller;
    try {
      const [extensions, tools] = await Promise.all([request<ExtensionData>("/api/extensions", controller.signal), request<ToolCatalogItem[]>("/api/tools?mode=chat", controller.signal)]);
      if (!controller.signal.aborted) { setData(extensions); setBuiltins(tools.filter(tool => !tool.extensionId)); if (clearError) setError(""); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "扩展加载失败。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; loadRequest.current?.abort(); operation.current?.abort(); }; }, [load]);

  const upsert = (row: ExtensionView) => setData(old => ({ ...old, items: old.items.some(item => item.id === row.id) ? old.items.map(item => item.id === row.id ? row : item) : [...old.items, row] }));
  function openEditor(row: ExtensionView | "new", draft?: RegistryConnectionDraft, trigger?: HTMLElement | null) { opener.current = trigger ?? document.activeElement as HTMLElement; setRegistryDraft(draft); setEditor(row); setEditorSession(old => old + 1); setEditorOpen(true); }
  function openTools(row: ExtensionView, trigger: HTMLElement) { opener.current = trigger; setToolSheet(row); setToolsSession(old => old + 1); setToolsOpen(true); }
  const returnFocus = () => { (opener.current?.isConnected ? opener.current : document.getElementById("extension-add"))?.focus(); };
  async function mutate(key: string, action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    loadRequest.current?.abort();
    const controller = new AbortController(); operation.current = controller; setBusy(key); setError(""); setNotice("");
    try { await action(controller.signal); }
    catch (failure) {
      if (!alive.current) return;
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : "扩展操作失败。"); await load(false); }
      else { setNotice("检测已取消。"); await load(); }
    } finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(""); } }
  }
  const enabledCount = data.items.filter(item => item.enabled).length;
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-4 py-8 md:px-6">
    <header className="workspace-page-header"><div className="flex flex-col gap-2"><h1>扩展管理</h1><p className="text-sm text-muted-foreground">连接你的服务，为助理添加更多工具。</p></div><div className="flex items-center gap-2">{tab === "mine" && <Button size="sm" variant="ghost" disabled={loading || !!busy} onClick={() => void load()}><RefreshCw data-icon="inline-start" />刷新</Button>}<Button id="extension-add" size="sm" disabled={loading || !!busy || data.items.length >= 20} onClick={() => openEditor("new")}><Plus data-icon="inline-start" />添加扩展</Button></div></header>
    {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-5">
      <TabsList aria-label="扩展视图" className="self-start"><TabsTrigger value="mine">我的扩展</TabsTrigger><TabsTrigger value="discover">发现扩展</TabsTrigger></TabsList>
      <TabsContent value="discover"><ExtensionDiscovery canAdd={!loading && !busy && data.items.length < 20} connectedUrls={data.items.flatMap(item => item.config.type === "mcp-http" ? [item.config.url] : [])} onAdd={(draft, trigger) => openEditor("new", draft, trigger)} /></TabsContent>
      <TabsContent value="mine" className="flex flex-col gap-5">
    <section aria-label="已配置扩展" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">我的扩展 <span className="ml-2 text-muted-foreground">{data.items.length}</span></h2><span className="text-xs text-muted-foreground">{enabledCount} 个已启用</span></div>
      {loading ? <><Skeleton className="h-36" /><Skeleton className="h-36" /></> : !data.items.length ? <Empty><EmptyHeader><EmptyMedia><Puzzle /></EmptyMedia><EmptyTitle>连接第一个扩展</EmptyTitle><EmptyDescription>添加 MCP 服务或 HTTP 接口，检测连接后选择需要的工具。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => openEditor("new")}><Plus data-icon="inline-start" />添加扩展</Button></Empty> : data.items.map(row => <Card key={row.id} data-testid={`extension-${row.id}`}>
        <CardHeader className="flex-row items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Cable className="size-4" aria-hidden="true" /></div><div className="flex min-w-0 flex-1 flex-col gap-1"><CardTitle className="break-words [overflow-wrap:anywhere]">{row.name}</CardTitle><CardDescription className="truncate" title={connectionLabel(row)}>{connectionLabel(row)}</CardDescription></div><Badge className="shrink-0" variant={row.error ? "danger" : row.enabled ? "success" : "secondary"}>{stateLabel(row)}</Badge></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2"><Badge variant="outline">{labels[row.config.type]}</Badge><span className="text-xs text-muted-foreground">{row.tools.filter(tool => tool.enabled).length} / {row.tools.length} 个工具已选择</span>{row.hasCredentials && <span className="text-xs text-muted-foreground">凭据已配置</span>}{row.error && <p className="w-full break-words text-xs text-destructive">{row.error}</p>}</CardContent>
        <CardFooter className="flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={!!busy} onClick={event => { const trigger = event.currentTarget; void mutate(`${row.id}:test`, async signal => { const updated = await request<ExtensionView>(`/api/extensions/${row.id}/test`, signal, "POST", { revision: row.revision }); upsert(updated); openTools(updated, trigger); setNotice(updated.tools.length ? "连接成功，请确认需要启用的工具。" : "连接成功，该服务未提供工具。"); }); }}>{busy === `${row.id}:test` ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}检测连接</Button><Button size="sm" variant="ghost" disabled={!!busy || !row.tools.length} onClick={event => openTools(row, event.currentTarget)}>管理工具<ChevronRight data-icon="inline-end" /></Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => openEditor(row)}><Settings2 data-icon="inline-start" />配置</Button>{row.enabled && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void mutate(`${row.id}:disable`, async signal => { upsert(await request<ExtensionView>(`/api/extensions/${row.id}`, signal, "PATCH", { revision: row.revision, enabled: false, tools: row.tools.filter(tool => tool.enabled).map(tool => tool.name) })); setNotice("扩展已停用，新的工具调用将被阻止。"); })}><Power data-icon="inline-start" />停用</Button>}<Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`删除扩展 ${row.name}`} disabled={!!busy} onClick={() => { if (window.confirm(`删除扩展“${row.name}”？连接配置和凭据将被移除，已有聊天记录保留。`)) void mutate(`${row.id}:delete`, async signal => { await request(`/api/extensions/${row.id}?revision=${row.revision}`, signal, "DELETE"); setData(old => ({ ...old, items: old.items.filter(item => item.id !== row.id) })); setNotice("扩展已删除。"); }); }}><Trash2 /></Button></CardFooter>
        {busy === `${row.id}:test` && <CardFooter><Button size="sm" variant="outline" onClick={() => operation.current?.abort()}>取消检测</Button></CardFooter>}
      </Card>)}
    </section>
    <details className="settings-disclosure"><summary className="settings-disclosure-trigger">内置工具 <Badge variant="secondary">{builtins.length}</Badge><ChevronRight className="ml-auto size-4" aria-hidden="true" /></summary><div className="flex flex-col gap-3 py-4">{builtins.map(tool => <div className="flex items-center justify-between gap-3 px-1" key={tool.id}><div className="flex min-w-0 flex-col gap-1"><span className="text-sm">{tool.displayName}</span><span className="text-xs text-muted-foreground">{tool.description}</span></div><Badge variant={tool.available ? "success" : "outline"}>{tool.available ? "可用" : tool.reason === "noDirectoryGranted" ? "待授权目录" : "待配置"}</Badge></div>)}</div></details>
    <p className="text-xs leading-6 text-muted-foreground">启用的外部工具通过聊天调用，每次执行前需要确认。<Link className="ml-1 underline underline-offset-4" href="/assistants">在助理模板中选择工具</Link>。扩展配置仅保存在本机，工作区恢复后需要重新检测并启用。</p>
      </TabsContent>
    </Tabs>
    {editor !== null && <ExtensionEditor key={editorSession} open={editorOpen} returnFocus={returnFocus} draft={registryDraft} row={editor === "new" ? null : editor} encryptionAvailable={data.encryptionAvailable} localProcessesAllowed={data.localProcessesAllowed} onClose={() => setEditorOpen(false)} onSaved={row => { upsert(row); setEditorOpen(false); setTab("mine"); setNotice("配置已保存，请检测连接。修改配置会停用扩展及旧的待确认调用。"); }} />}
    {toolSheet && <ExtensionTools key={toolsSession} open={toolsOpen} returnFocus={returnFocus} error={error} row={toolSheet} busy={!!busy} onClose={() => setToolsOpen(false)} onSave={selected => void mutate(`${toolSheet.id}:activate`, async signal => { const updated = await request<ExtensionView>(`/api/extensions/${toolSheet.id}`, signal, "PATCH", { revision: toolSheet.revision, enabled: true, tools: selected }); upsert(updated); setToolsOpen(false); setNotice("所选工具已启用，可在聊天中使用。"); })} />}
  </main>;
}

function ExtensionTools({ row, open, returnFocus, error, busy, onClose, onSave }: { open: boolean; returnFocus: () => void; error: string; row: ExtensionView; busy: boolean; onClose: () => void; onSave: (selected: string[]) => void }) {
  const [selected, setSelected] = useState(() => row.tools.filter(tool => tool.enabled).map(tool => tool.name));
  return <Sheet open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><SheetContent side="right" className="extension-editor flex flex-col" closeLabel="关闭工具管理" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}><header className="flex shrink-0 flex-col gap-2 px-6 pb-4 pt-7 pr-14"><SheetTitle className="break-words [overflow-wrap:anywhere]">{row.name} · 工具</SheetTitle><SheetDescription>只启用需要的工具。每次调用仍会显示确认；修改选择会使旧的待确认调用失效。</SheetDescription>{error && <Alert variant="destructive"><AlertTitle>未更新</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}</header><div className="chat-list-scroll min-h-0 flex-1 overflow-y-auto px-6"><FieldSet disabled={busy}><FieldLegend>可用工具 · {row.tools.length}</FieldLegend><FieldGroup className="gap-4">{row.tools.map(tool => <Field key={tool.name} orientation="horizontal"><input id={`extension-tool-${tool.id}`} type="checkbox" checked={selected.includes(tool.name)} onChange={event => setSelected(old => event.target.checked ? [...old, tool.name] : old.filter(name => name !== tool.name))} /><div className="flex min-w-0 flex-1 flex-col gap-1"><FieldLabel className="break-all" htmlFor={`extension-tool-${tool.id}`}>{tool.name}</FieldLabel><p className="break-words text-xs leading-5 text-muted-foreground">{tool.description}</p><details className="settings-disclosure"><summary className="settings-disclosure-trigger">参数格式</summary><pre className="chat-list-scroll overflow-x-auto whitespace-pre-wrap break-all pb-3 text-xs text-muted-foreground">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div></Field>)}</FieldGroup></FieldSet></div><footer className="flex shrink-0 items-center justify-between gap-2 px-6 py-4"><span className="text-xs text-muted-foreground">已选择 {selected.length} 个</span><Button disabled={busy || !row.tested || !selected.length} onClick={() => onSave(selected)}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{row.enabled ? "保存工具选择" : "启用所选工具"}</Button></footer></SheetContent></Sheet>;
}
