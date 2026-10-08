"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantTemplate } from "@/lib/assistants/schema";
import { topicConfigSchema, type TopicConfig } from "@/lib/topics/schema";

export function TopicEditor({ initial, collections, assistants, busy, save, cancel }: { initial: TopicConfig; collections: string[]; assistants: AssistantTemplate[]; busy: boolean; save: (config: TopicConfig) => Promise<void>; cancel?: () => void }) {
  const [config, setConfig] = useState(initial); const [custom, setCustom] = useState(""); const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); const parsed = topicConfigSchema.safeParse(config);
    if (!parsed.success) { setError("请填写专题名称，选择 1–12 个资料集合，每个名称不超过 40 字符。"); return; }
    setError(""); await save(parsed.data);
  }
  const names = [...new Set([...collections, ...config.collections])].sort();
  return <form className="space-y-3" onSubmit={event => void submit(event)}>
    <label className="block space-y-1 text-sm">专题名称<Input aria-label="专题名称" disabled={busy} maxLength={60} value={config.name} onChange={event => setConfig({ ...config, name: event.target.value })} required /></label>
    <label className="block space-y-1 text-sm">专题说明<Textarea aria-label="专题说明" disabled={busy} maxLength={500} value={config.description} onChange={event => setConfig({ ...config, description: event.target.value })} /></label>
    <fieldset disabled={busy} className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm">专题资料集合</legend>
      <p className="text-xs text-muted-foreground">只使用选中的集合；暂无文档的集合会保留，便于之后导入。专题默认范围用于新会话和成果生成。</p>
      <div className="flex max-h-48 flex-wrap gap-3 overflow-y-auto">{names.map(name => <label className="flex min-w-0 items-center gap-1 break-all text-sm" key={name}><input type="checkbox" checked={config.collections.includes(name)} onChange={event => setConfig({ ...config, collections: event.target.checked ? [...config.collections, name] : config.collections.filter(value => value !== name) })} />{name}</label>)}</div>
      <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" aria-label="添加资料集合" maxLength={40} value={custom} onChange={event => setCustom(event.target.value)} /><Button type="button" variant="outline" disabled={!custom.trim() || config.collections.length >= 12} onClick={() => { setConfig({ ...config, collections: [...new Set([...config.collections, custom.trim()])] }); setCustom(""); }}>添加集合</Button></div>
    </fieldset>
    <label className="block space-y-1 text-sm">默认助理模板<select aria-label="默认助理模板" className="w-full rounded-md border bg-background p-2" disabled={busy} value={config.assistantTemplateId ?? ""} onChange={event => setConfig({ ...config, assistantTemplateId: event.target.value || null })}>
      <option value="">使用当前聊天默认模型</option>{assistants.map(assistant => <option value={assistant.id} key={assistant.id}>{assistant.config.name}</option>)}
      {config.assistantTemplateId && !assistants.some(assistant => assistant.id === config.assistantTemplateId) ? <option value={config.assistantTemplateId}>原模板已不可用，请重新选择</option> : null}
    </select></label>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex gap-2"><Button disabled={busy} type="submit">保存专题</Button>{cancel ? <Button disabled={busy} variant="outline" type="button" onClick={cancel}>取消编辑</Button> : null}</div>
  </form>;
}
