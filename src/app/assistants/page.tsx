"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { assistantConfigSchema, type AssistantConfig, type AssistantTemplate } from "@/lib/assistants/schema";
import { modelRefKey, type ModelLibraryItem } from "@/lib/models/preferences-schema";
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mutation = useRef(false);
  async function load(signal?: AbortSignal) {
    const [assistants, preferences, catalog] = await Promise.all([
      chatApi.listAssistants(signal), request<{ data: { library: ModelLibraryItem[] } }>("/api/models", { signal }),
      request<{ data: ToolOption[] }>("/api/tools?mode=chat", { signal }),
    ]);
    if (signal?.aborted) return;
    setTemplates(assistants.data); setModels(preferences.data.library.filter(item => item.modes.includes("chat"))); setTools(catalog.data);
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
    setCollections(template?.config.collections.join("\n") ?? ""); setNotice(""); setError("");
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
      select(null); setNotice("模板已保存。已有会话保留原快照，可在会话中主动更新。");
      try { await load(); } catch { setError("模板已保存，但列表刷新失败，请刷新列表后继续操作。"); }
    });
  }
  return <main className="page-container mx-auto w-full max-w-6xl space-y-6 overflow-y-auto p-4 sm:p-8">
    <div><h1 className="text-2xl font-semibold">助理模板</h1><p className="mt-2 text-sm text-muted-foreground">保存工作方式，选择知识范围和可用工具。应用后保存在会话内，修改模板不会自动改变旧会话。</p></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error} <button type="button" className="underline" disabled={busy} onClick={() => void run(() => load())}>刷新列表</button></p> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3" aria-label="模板列表">
        <Button disabled={busy || loading} variant="outline" onClick={() => select(null)}>新建模板</Button>
        {loading ? <p role="status">正在加载模板…</p> : null}
        {templates.map(template => <Card key={template.id} data-testid={`assistant-template-${template.id}`}><CardHeader><CardTitle className="text-base">{template.config.name}</CardTitle><CardDescription>{template.config.description || "自定义工作方式"}</CardDescription></CardHeader><CardContent className="space-y-3"><p className="text-xs text-muted-foreground">{template.builtin ? "内置 · 只读" : `自定义 · v${template.revision}`} · {template.config.tools.length} 个工具 · {template.config.usesMemory ? "使用记忆" : "关闭记忆"} · {template.config.collections.join("、") || "全部知识集合"}</p><div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || loading} onClick={() => void run(async () => { const created = await chatApi.createConversation(template.config.name, template.id); window.localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, created.data.id); router.push("/chat"); })}>使用模板新建会话</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => select(template, true)}>复制</Button>
          {!template.builtin ? <><Button size="sm" variant="outline" disabled={busy} onClick={() => select(template)}>编辑</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`删除“${template.config.name}”？已有会话会保留快照。`)) void run(async () => { await request(`/api/assistants/${encodeURIComponent(template.id)}?confirm=true&revision=${template.revision}`, { method: "DELETE" }); await load(); if (editing?.id === template.id) select(null); setNotice("模板已删除，已有会话快照已保留。"); }); }}>删除</Button></> : null}
        </div></CardContent></Card>)}
      </section>
      <Card><CardHeader><CardTitle>{editing ? `编辑：${editing.config.name}` : "新建自定义模板"}</CardTitle><CardDescription>工具仍遵守原有审批和文件夹授权。知识集合和记忆开关可在会话内进一步调整。</CardDescription></CardHeader><CardContent><form onSubmit={save} className="space-y-4"><fieldset disabled={busy || loading} className="space-y-4">
        <label className="block space-y-1 text-sm"><span>模板名称</span><Input required maxLength={60} value={config.name} onChange={event => setConfig({ ...config, name: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>简介</span><Input maxLength={300} value={config.description} onChange={event => setConfig({ ...config, description: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>助理指令</span><Textarea aria-label="助理指令" required maxLength={6000} className="min-h-40" value={config.instructions} onChange={event => setConfig({ ...config, instructions: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>绑定聊天模型</span><select className="w-full rounded-md border bg-background p-2" value={config.model ? modelRefKey(config.model) : ""} onChange={event => { const item = models.find(model => modelRefKey(model) === event.target.value); setConfig({ ...config, model: item ? { providerId: item.providerId, modelId: item.modelId } : null }); }}><option value="">跟随会话选择</option>{config.model && !models.some(model => modelRefKey(model) === modelRefKey(config.model!)) ? <option value={modelRefKey(config.model)}>已移除：{config.model.modelId}</option> : null}{models.map(model => <option key={modelRefKey(model)} value={modelRefKey(model)}>{model.name} · {model.providerId}</option>)}</select></label>
        <fieldset className="space-y-2"><legend className="text-sm">可用工具（全部不选即禁用工具）</legend><div className="flex flex-wrap gap-3">{tools.map(tool => <label className="flex items-center gap-2 text-sm" key={tool.id}><input type="checkbox" checked={config.tools.includes(tool.id)} onChange={event => setConfig({ ...config, tools: event.target.checked ? [...config.tools, tool.id] : config.tools.filter(id => id !== tool.id) })} />{tool.displayName}</label>)}</div></fieldset>
        <label className="block space-y-1 text-sm"><span>知识集合（每行一个，留空为全部）</span><Textarea aria-label="知识集合（每行一个，留空为全部）" maxLength={600} value={collections} onChange={event => setCollections(event.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.usesMemory} onChange={event => setConfig({ ...config, usesMemory: event.target.checked })} />使用长期记忆</label>
        <div className="grid gap-3 sm:grid-cols-3">{([
          ["semanticThreshold", "语义阈值", 0.1, 0.95, 0.05], ["maxSources", "证据数量", 1, 8, 1], ["contextChars", "证据字符预算", 1200, 9600, 100],
        ] as const).map(([key, label, min, max, step]) => <label className="space-y-1 text-sm" key={key}><span>{label}</span><Input type="number" required min={min} max={max} step={step} value={config.retrieval[key]} onChange={event => setConfig({ ...config, retrieval: { ...config.retrieval, [key]: Number(event.target.value) } })} /></label>)}</div>
        <p className="text-xs text-muted-foreground">语义阈值仅过滤向量召回，关键词证据仍可返回。更高阈值可能遗漏资料，请结合检索质量评测调整。</p>
        <Button type="submit">{busy ? "正在保存…" : "保存模板"}</Button>
      </fieldset></form></CardContent></Card>
    </div>
  </main>;
}
