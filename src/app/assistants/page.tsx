"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Copy, CopyPlus, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TemplateEditor } from "@/features/assistants/template-editor";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { writeToClipboard } from "@/lib/clipboard";
import { assistantConfigSchema, type AssistantConfig, type AssistantTemplate } from "@/lib/assistants/schema";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import { chatApi } from "@/features/chat/api-client";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";

type ToolOption = { id: string; displayName: string };
const initialConfig: AssistantConfig = { name: "", description: "", instructions: "", model: null, tools: [], collections: [], usesMemory: true, retrieval: { semanticThreshold: 0.35, maxSources: 8, contextChars: 8000 } };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, "模板操作失败"));
  return payload as T;
}

export default function AssistantsPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<AssistantTemplate[]>([]);
  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [editing, setEditing] = useState<AssistantTemplate | null>(null);
  const [config, setConfig] = useState(initialConfig);
  const [collections, setCollections] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mutation = useRef(false);
  const editorTrigger = useRef<HTMLElement | null>(null);

  async function load(signal?: AbortSignal) {
    const [assistants, preferences, catalog] = await Promise.all([
      chatApi.listAssistants(signal), request<{ data: { library: ModelLibraryItem[] } }>("/api/models", { signal }),
      request<{ data: ToolOption[] }>("/api/tools?mode=chat", { signal }),
    ]);
    if (signal?.aborted) return;
    setTemplates(assistants.data);
    setModels(preferences.data.library.filter(item => item.modes.includes("chat")));
    setTools(catalog.data);
  }
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function run(operation: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : "模板操作失败"); }
    finally { mutation.current = false; setBusy(false); }
  }
  function select(template: AssistantTemplate | null, copy = false) {
    setEditing(copy ? null : template);
    setConfig(template ? { ...template.config, name: copy ? `${template.config.name.slice(0, 54)} 副本` : template.config.name } : initialConfig);
    setCollections(template?.config.collections.join("\n") ?? "");
    setNotice(""); setError(""); setEditorOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const parsed = assistantConfigSchema.safeParse({ ...config, collections: collections.split("\n").map(item => item.trim()).filter(Boolean) });
      if (!parsed.success) throw new Error(parsed.error.issues.map(item => `${item.path.join(".")}: ${item.message}`).join("；"));
      await request(editing ? `/api/assistants/${encodeURIComponent(editing.id)}` : "/api/assistants", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { revision: editing.revision, config: parsed.data } : parsed.data),
      });
      setNotice("模板已保存。已有会话保留原快照，可在会话中主动更新。");
      try { await load(); } catch { setError("模板已保存，但列表刷新失败，请刷新列表后继续操作。"); }
      setEditorOpen(false);
    });
  }

  return <main className="page-container mx-auto flex w-full max-w-5xl flex-col gap-5">
    <header className="workspace-page-header">
      <div><h1>助理模板</h1><p className="mt-2 text-sm text-muted-foreground">为不同工作保存指令、工具与知识范围。</p></div>
      <Button id="new-template" disabled={busy || loading} onClick={event => { editorTrigger.current = event.currentTarget; select(null); }}><Plus data-icon="inline-start" />新建模板</Button>
    </header>
    {error && !editorOpen ? <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => load())}>刷新列表</Button></p> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    {loading ? <div role="status" aria-label="正在加载模板" className="flex flex-col gap-2">{[0, 1, 2].map(key => <Skeleton key={key} className="h-24 rounded-xl" />)}</div> : null}
    {[true, false].map(builtin => {
      const group = templates.filter(template => template.builtin === builtin);
      if (!group.length) return null;
      return <section key={String(builtin)} aria-label={builtin ? "内置模板" : "我的模板"} className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 px-3 text-xs text-muted-foreground">{builtin ? "内置模板" : "我的模板"}<Badge variant="secondary">{group.length}</Badge></h2>
        {group.map(template => <article key={template.id} data-testid={`assistant-template-${template.id}`} className="management-row flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl p-3 sm:p-4">
          <div className="min-w-0 flex-1 basis-56">
            <h3 className="truncate text-sm font-semibold" title={template.config.name}>{template.config.name}</h3>
            <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{template.config.description || "自定义工作方式"}</p>
            <p className="mt-1.5 truncate text-xs text-muted-foreground">{template.config.tools.length} 个工具 · {template.config.usesMemory ? "使用记忆" : "关闭记忆"} · {template.config.collections.length ? `${template.config.collections.length} 个知识集合` : "全部知识集合"}{!template.builtin ? ` · v${template.revision}` : ""}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" aria-label="使用模板新建会话" disabled={busy || loading} onClick={() => void run(async () => { const created = await chatApi.createConversation(template.config.name, template.id); window.localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, created.data.id); router.push("/chat"); })}>新建会话</Button>
            <Button size="icon-sm" variant="ghost" aria-label="复制" title="复制助理指令" disabled={busy} onClick={() => void run(async () => {
              const outcome = await writeToClipboard(template.config.instructions);
              if (outcome !== "copied") throw new Error(outcome === "refused" ? "无法写入剪贴板，请允许剪贴板访问后重试。" : "当前环境不支持剪贴板，请打开创建副本后选择并复制助理指令。");
              setNotice(`已复制“${template.config.name}”的助理指令。`);
            })}><Copy aria-hidden="true" /></Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`更多操作 ${template.config.name}`} disabled={busy} onPointerDown={event => { editorTrigger.current = event.currentTarget; }} onKeyDown={event => { editorTrigger.current = event.currentTarget; }}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (editorOpen) event.preventDefault(); }}>
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => select(template, true)}><CopyPlus aria-hidden="true" />创建副本</DropdownMenuItem>
                  {!template.builtin ? <>
                    <DropdownMenuItem onSelect={() => select(template)}><Pencil aria-hidden="true" />编辑</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => { if (window.confirm(`删除“${template.config.name}”？已有会话会保留快照。`)) void run(async () => { await request(`/api/assistants/${encodeURIComponent(template.id)}?confirm=true&revision=${template.revision}`, { method: "DELETE" }); await load(); setNotice("模板已删除，已有会话快照已保留。"); }); }}><Trash2 aria-hidden="true" />删除</DropdownMenuItem>
                  </> : null}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </article>)}
      </section>;
    })}
    <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
      <SheetContent side="right" className="template-editor-sheet flex flex-col gap-5 p-5 sm:p-6" onCloseAutoFocus={event => { event.preventDefault(); const target = editorTrigger.current; (target?.isConnected ? target : document.getElementById("new-template"))?.focus(); }}>
        <header className="flex flex-col gap-2 pr-8"><SheetTitle className="break-words text-lg font-semibold">{editing ? `编辑：${editing.config.name}` : "新建自定义模板"}</SheetTitle><SheetDescription className="text-sm text-muted-foreground">应用到会话后独立保存，后续修改不会影响已有会话。</SheetDescription></header>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <TemplateEditor config={config} setConfig={setConfig} collections={collections} setCollections={setCollections} models={models} tools={tools} disabled={busy || loading} busy={busy} onSubmit={save} />
      </SheetContent>
    </Sheet>
  </main>;
}
