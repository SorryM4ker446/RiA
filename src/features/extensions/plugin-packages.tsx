"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Download, Loader2, Package, Power, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { ExtensionView } from "@/lib/extensions/store";
import type { PluginManifest, PluginPreview, PluginView } from "@/lib/plugins/types";
import { SkillMarketplace } from "./skill-marketplace";
import { SkillFiles } from "./skill-files";

type Props = {
  mode: "installed" | "market"; plugins: PluginView[]; catalog: PluginPreview[];
  connections: ExtensionView[]; busy: boolean; loading: boolean;
  actionError: string; localProcessesAllowed: boolean;
  onInstall: (preview: PluginPreview, allowLocal: boolean, onInstalled: () => void) => void;
  onToggle: (plugin: PluginView) => void; onUninstall: (plugin: PluginView) => void;
  onConnection: (action: "configure" | "detect" | "tools", row: ExtensionView, trigger: HTMLElement | null) => void;
};
const ready = (row: ExtensionView) => row.enabled && row.tested && row.credentialsAvailable && row.tools.some(tool => tool.enabled);

export function PluginPackages({ mode, plugins, catalog, connections, busy, loading, actionError, localProcessesAllowed, onInstall, onToggle, onUninstall, onConnection }: Props) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<PluginView | null>(null);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [allowLocal, setAllowLocal] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const draftVersion = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const handoff = useRef(false);
  useEffect(() => () => { pending.current?.abort(); draftVersion.current++; }, []);
  const current = installed ? plugins.find(plugin => plugin.id === installed.id) ?? null : null;
  const manifest = current?.manifest ?? preview?.manifest;
  const owned = current ? connections.filter(row => row.pluginId === current.id) : [];
  const needsSetup = current ? owned.length !== current.connections.length || owned.some(row => !ready(row)) : false;
  const needsLocal = manifest?.connections.some(connection => connection.config.type === "mcp-stdio") ?? false;

  function show(trigger: HTMLElement, item?: PluginPreview, plugin?: PluginView) {
    pending.current?.abort(); pending.current = null; draftVersion.current++;
    opener.current = trigger; handoff.current = false;
    setInstalled(plugin ?? null); setSource(""); setPreview(item ?? null); setPreviewing(false); setError(""); setAllowLocal(false); setOpen(true);
  }
  function changeSource(value: string) {
    pending.current?.abort(); pending.current = null; draftVersion.current++;
    setSource(value); setPreview(null); setPreviewing(false); setError(""); setAllowLocal(false);
  }
  async function readFile(file?: File) {
    if (!file) return;
    changeSource(""); const version = draftVersion.current;
    if (file.size > 2_097_152) { setError("插件包不能超过 2 MiB。"); return; }
    try { const text = await file.text(); if (version === draftVersion.current) changeSource(text); }
    catch { if (version === draftVersion.current) setError("无法读取插件包。"); }
  }
  async function inspect() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setError(""); setPreviewing(true);
    try {
      if (new TextEncoder().encode(source).length > 2_097_152) throw new Error("插件包不能超过 2 MiB。");
      let value: unknown; try { value = JSON.parse(source); } catch { throw new Error("请输入有效的 JSON 插件包。"); }
      const response = await fetch("/api/plugins/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, "插件格式不受支持。"));
      if (!controller.signal.aborted) setPreview(payload.data);
    } catch (failure) { if (!controller.signal.aborted && pending.current === controller) setError(failure instanceof Error ? failure.message : "无法预览插件。"); }
    finally { if (pending.current === controller) { pending.current = null; setPreviewing(false); } }
  }
  const shown = catalog.filter(item => `${item.manifest.name} ${item.manifest.description} ${item.manifest.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section aria-label={mode === "market" ? "RiA 插件市场" : "已安装插件"} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-col gap-1"><h2 className="text-sm font-medium">{mode === "market" ? "插件市场" : `我的插件 · ${plugins.length}`}</h2><p className="text-xs text-muted-foreground">{mode === "market" ? "发现社区 Skill 与 RiA 组合包，安装后统一管理。" : "技能与连接统一管理，启用后供聊天使用。"}</p></div><Button id="plugin-import" size="sm" variant="outline" disabled={busy || loading} onClick={event => show(event.currentTarget)}><Upload data-icon="inline-start" />导入插件</Button></div>
    {mode === "market" && <><SkillMarketplace plugins={plugins} busy={busy} actionError={actionError} onInstall={onInstall} /><div className="flex flex-col gap-1 pt-3"><h3 className="text-sm font-medium">RiA 精选插件</h3><p className="text-xs text-muted-foreground">内置组合包，也可导入已有的 RiA 插件包。</p></div><Field><FieldLabel className="sr-only" htmlFor="plugin-search">搜索插件</FieldLabel><Input id="plugin-search" placeholder="筛选精选插件…" value={search} onChange={event => setSearch(event.target.value)} /></Field></>}
    {loading ? <Skeleton className="h-28 rounded-xl" /> : mode === "market" ? <div className="flex flex-col gap-2">{shown.map(item => {
      const exists = plugins.some(plugin => plugin.packageId === item.manifest.id);
      return <article key={item.manifest.id} className="registry-result-row management-row flex items-start gap-3 rounded-xl p-4"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Package className="size-4" aria-hidden="true" /></div><div className="flex min-w-0 flex-1 flex-col gap-2"><h3 className="break-words text-sm font-medium">{item.manifest.name}</h3><p className="text-sm leading-6 text-muted-foreground">{item.manifest.description}</p><PluginContents manifest={item.manifest} /><Button size="sm" variant="ghost" className="self-start" disabled={busy || exists} onClick={event => show(event.currentTarget, item)}>{exists ? <><Check data-icon="inline-start" />已安装</> : <>查看插件<ArrowRight data-icon="inline-end" /></>}</Button></div></article>;
    })}{!shown.length && <Empty><EmptyHeader><EmptyMedia><Search /></EmptyMedia><EmptyTitle>没有匹配的插件</EmptyTitle><EmptyDescription>换个关键词，或导入自己的 RiA 插件包。</EmptyDescription></EmptyHeader></Empty>}</div> : plugins.length ? <div className="flex flex-col gap-2">{plugins.map(plugin => {
      const rows = connections.filter(row => row.pluginId === plugin.id);
      const incomplete = rows.length !== plugin.connections.length || rows.some(row => !ready(row));
      return <article key={plugin.id} data-testid={`plugin-${plugin.id}`} className="registry-result-row management-row flex flex-wrap items-center gap-3 rounded-xl p-4"><Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="flex min-w-0 flex-1 flex-col gap-1"><Button variant="ghost" size="sm" className="self-start" onClick={event => show(event.currentTarget, undefined, plugin)}>{plugin.manifest.name}</Button><p className="break-words text-xs text-muted-foreground">{plugin.manifest.marketplace ? "skills.sh" : `v${plugin.manifest.version}`} · {plugin.manifest.skills.length} 个技能 · {plugin.connections.length} 个连接</p></div><Badge variant={plugin.enabled && !incomplete ? "success" : "secondary"}>{incomplete ? "待配置" : plugin.enabled ? "已启用" : "已停用"}</Badge><Button size="sm" variant="ghost" disabled={busy || (!plugin.enabled && incomplete)} onClick={() => onToggle(plugin)}><Power data-icon="inline-start" />{plugin.enabled ? "停用插件" : "启用插件"}</Button><Button size="icon-sm" variant="ghost" aria-label={`卸载插件 ${plugin.manifest.name}`} disabled={busy} onClick={() => onUninstall(plugin)}><Trash2 /></Button></article>;
    })}</div> : <Empty><EmptyHeader><EmptyMedia><Package /></EmptyMedia><EmptyTitle>还没有安装插件</EmptyTitle><EmptyDescription>从“插件市场”选择技能，或导入包含技能和连接的插件包。</EmptyDescription></EmptyHeader></Empty>}
    <Sheet open={open} onOpenChange={value => { if (!busy && !value) { pending.current?.abort(); draftVersion.current++; setOpen(false); } }}><SheetContent side="right" className="plugin-package-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel="关闭插件详情" onCloseAutoFocus={event => { event.preventDefault(); if (!handoff.current) (opener.current?.isConnected ? opener.current : document.getElementById("plugin-import"))?.focus(); }}>
      <header className="flex shrink-0 flex-col gap-2 pr-8"><SheetTitle className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{manifest?.name ?? "导入插件"}</SheetTitle><SheetDescription className="break-words text-xs [overflow-wrap:anywhere]">{manifest ? manifest.marketplace ? `${manifest.marketplace.repository} · skills.sh 快照` : `${manifest.author} · v${manifest.version} · ${manifest.id}` : "选择 .ria-plugin.json 文件，或粘贴 JSON 内容后预览。"}</SheetDescription></header>
      <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
        {(error || actionError) && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error || actionError}</AlertDescription></Alert>}
        {!current && !preview ? <FieldGroup><Field><FieldLabel htmlFor="plugin-file">插件包文件</FieldLabel><FileInput id="plugin-file" accept=".json,application/json" disabled={busy || previewing} onChange={event => void readFile(event.target.files?.[0])} buttonLabel="选择插件包" placeholder=".ria-plugin.json · 最大 2 MiB" /></Field><Field><FieldLabel htmlFor="plugin-source">插件包 JSON</FieldLabel><Textarea id="plugin-source" rows={8} value={source} disabled={busy} onChange={event => changeSource(event.target.value)} placeholder={'{"format":"ria-plugin","schemaVersion":1,…}'} /><FieldDescription>仅支持声明式技能与连接，不执行安装脚本。</FieldDescription></Field><Button variant="secondary" disabled={busy || previewing || !source.trim()} className="self-start" onClick={() => void inspect()}>{previewing && <Loader2 data-icon="inline-start" className="animate-spin" />}预览插件</Button></FieldGroup> : null}
        {!current && preview && source && <Button size="sm" variant="ghost" disabled={busy} className="self-start" onClick={() => { setPreview(null); setAllowLocal(false); }}>修改包内容</Button>}
        {manifest && <div className="plugin-preview flex flex-col gap-5"><p className="text-sm leading-7 text-muted-foreground">{manifest.description}</p><PluginContents manifest={manifest} />{manifest.marketplace && <SkillFiles key={current?.id ?? preview?.digest} snapshot={manifest.marketplace} />}<section aria-label="插件技能" className="flex flex-col gap-3"><h3 className="text-sm font-medium">技能</h3>{manifest.skills.length ? manifest.skills.map(skill => <details key={skill.id} className="settings-disclosure rounded-lg bg-muted/40 p-3"><summary className="settings-disclosure-trigger"><Sparkles className="size-4" aria-hidden="true" />{skill.name}</summary><p className="py-2 text-xs leading-6 text-muted-foreground">{skill.description}</p><pre className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{skill.instructions}</pre></details>) : <p className="text-xs text-muted-foreground">此插件只提供工具连接。</p>}</section>
          <section aria-label="插件连接" className="flex flex-col gap-3"><h3 className="text-sm font-medium">连接与配置</h3>{!manifest.connections.length && <p className="text-xs text-muted-foreground">无需连接服务，启用后即可使用技能。</p>}{manifest.connections.map(connection => {
            const row = owned.find(item => item.id === current?.connections.find(item => item.key === connection.id)?.id);
            const config = row?.config ?? connection.config;
            return <div key={connection.id} className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{row?.name ?? connection.name}</h4><Badge variant="outline">{config.type === "http" ? "HTTP API" : config.type === "mcp-stdio" ? "本地程序" : "MCP 服务"}</Badge>{row && <Badge variant={ready(row) ? "success" : "secondary"}>{ready(row) ? "已就绪" : "待配置 / 检测"}</Badge>}</div><code className="break-all text-xs leading-6 text-muted-foreground">{config.type === "mcp-stdio" ? config.command : config.url}</code>{connection.credentials.map(field => <p key={field.key} className="break-words text-xs leading-6 text-muted-foreground">{field.key} · {field.required ? "必填" : "可选"}{field.description ? ` · ${field.description}` : ""}</p>)}{row && <div className="flex flex-wrap gap-1">{(["configure", "detect", "tools"] as const).map(action => <Button key={action} size="sm" variant="ghost" disabled={busy || (action === "tools" && !row.tools.length)} onClick={() => { handoff.current = true; setOpen(false); onConnection(action, row, opener.current); }}>{action === "configure" ? "配置连接" : action === "detect" ? "检测连接" : "管理工具"}</Button>)}</div>}</div>;
          })}</section>
          {!current && <p className="text-xs leading-6 text-muted-foreground">安装后默认停用。含连接的插件需要检测并确认工具；外部调用仍逐次授权。发布者信息来自包声明。</p>}
          {!current && needsLocal && <><p className="text-xs text-muted-foreground">{localProcessesAllowed ? "本地程序按当前用户权限运行，请核对路径。" : "本地程序插件需要在桌面应用中安装。"}</p><Field orientation="horizontal"><input id="plugin-process-consent" type="checkbox" checked={allowLocal} onChange={event => setAllowLocal(event.target.checked)} disabled={busy || !localProcessesAllowed} /><FieldLabel htmlFor="plugin-process-consent">我确认此插件声明的本地程序路径，允许之后检测和调用这些程序。</FieldLabel></Field></>}
        </div>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => { pending.current?.abort(); draftVersion.current++; setOpen(false); }}>关闭</Button>{current ? <Button disabled={busy || (!current.enabled && needsSetup)} onClick={() => onToggle(current)}><Power data-icon="inline-start" />{current.enabled ? "停用插件" : "启用插件"}</Button> : preview && <Button disabled={busy || previewing || (needsLocal && !allowLocal) || plugins.some(plugin => plugin.packageId === preview.manifest.id)} onClick={() => onInstall(preview, allowLocal, () => setOpen(false))}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}安装插件</Button>}</footer>
    </SheetContent></Sheet>
  </section>;
}

function PluginContents({ manifest }: { manifest: PluginManifest }) {
  return <div className="flex flex-wrap gap-2"><Badge variant="secondary">{manifest.skills.length} 个技能</Badge><Badge variant="outline">{manifest.connections.length ? `${manifest.connections.length} 个工具连接` : "无需外部连接"}</Badge></div>;
}
