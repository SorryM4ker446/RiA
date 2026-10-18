"use client";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantConfig } from "@/lib/assistants/schema";
import { modelRefKey, type ModelLibraryItem } from "@/lib/models/preferences-schema";

type Props = {
  config: AssistantConfig;
  setConfig: Dispatch<SetStateAction<AssistantConfig>>;
  collections: string;
  setCollections: (value: string) => void;
  models: ModelLibraryItem[];
  tools: { id: string; displayName: string }[];
  disabled: boolean;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
};

export function TemplateEditor({ config, setConfig, collections, setCollections, models, tools, disabled, busy, onSubmit }: Props) {
  const toolOptions = [...tools, ...config.tools.filter(id => !tools.some(tool => tool.id === id)).map(id => ({ id, displayName: `已移除的工具 · ${id.slice(-8)}` }))];
  return <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
    <fieldset disabled={disabled} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
      <FieldGroup className="gap-4">
        <Field className="gap-2"><FieldLabel htmlFor="template-name">模板名称</FieldLabel><Input id="template-name" required maxLength={60} value={config.name} onChange={event => setConfig({ ...config, name: event.target.value })} /></Field>
        <Field className="gap-2"><FieldLabel htmlFor="template-description">简介</FieldLabel><Input id="template-description" maxLength={300} value={config.description} onChange={event => setConfig({ ...config, description: event.target.value })} /></Field>
        <Field className="gap-2"><FieldLabel htmlFor="template-instructions">助理指令</FieldLabel><Textarea id="template-instructions" required maxLength={6000} className="min-h-32" value={config.instructions} onChange={event => setConfig({ ...config, instructions: event.target.value })} /></Field>
        <Field className="gap-2"><FieldLabel htmlFor="template-model">绑定聊天模型</FieldLabel><SelectField id="template-model" value={config.model ? modelRefKey(config.model) : ""} onValueChange={value => { const item = models.find(model => modelRefKey(model) === value); setConfig({ ...config, model: item ? { providerId: item.providerId, modelId: item.modelId } : null }); }}>
          <SelectOption value="">跟随会话选择</SelectOption>
          {config.model && !models.some(model => modelRefKey(model) === modelRefKey(config.model!)) ? <SelectOption value={modelRefKey(config.model)}>已移除：{config.model.modelId}</SelectOption> : null}
          {models.map(model => <SelectOption key={modelRefKey(model)} value={modelRefKey(model)}>{model.name} · {model.providerId}</SelectOption>)}
        </SelectField></Field>
        <FieldSet className="gap-2"><FieldLegend variant="label">可用工具</FieldLegend><FieldDescription>仅允许所选工具；仍需遵守审批与文件授权。</FieldDescription>
          <FieldGroup className="grid grid-cols-1 gap-1 sm:grid-cols-2">{toolOptions.map(tool => <Field key={tool.id} orientation="horizontal" className="gap-2 rounded-md px-2 py-1.5"><input id={`template-tool-${tool.id}`} type="checkbox" className="size-3.5 shrink-0 accent-foreground" checked={config.tools.includes(tool.id)} onChange={event => setConfig({ ...config, tools: event.target.checked ? [...config.tools, tool.id] : config.tools.filter(id => id !== tool.id) })} /><FieldLabel htmlFor={`template-tool-${tool.id}`} className="min-w-0 break-words">{tool.displayName}</FieldLabel></Field>)}</FieldGroup>
        </FieldSet>
        <Field className="gap-2"><FieldLabel htmlFor="template-collections">知识集合（每行一个，留空为全部）</FieldLabel><Textarea id="template-collections" rows={2} maxLength={600} value={collections} onChange={event => setCollections(event.target.value)} /></Field>
        <Field orientation="horizontal" className="gap-2"><input id="template-memory" type="checkbox" className="size-3.5 accent-foreground" checked={config.usesMemory} onChange={event => setConfig({ ...config, usesMemory: event.target.checked })} /><FieldLabel htmlFor="template-memory">使用长期记忆</FieldLabel></Field>
      </FieldGroup>
      <details className="settings-disclosure">
        <summary className="settings-disclosure-trigger justify-between">检索策略<ChevronDown className="size-4" aria-hidden="true" /></summary>
        <FieldGroup className="gap-3 pt-3">
          {([
            ["semanticThreshold", "语义阈值", 0.1, 0.95, 0.05], ["maxSources", "证据数量", 1, 8, 1], ["contextChars", "证据字符预算", 1200, 9600, 100],
          ] as const).map(([key, label, min, max, step]) => <Field orientation="horizontal" key={key} className="justify-between"><FieldLabel htmlFor={`template-${key}`}>{label}</FieldLabel><Input id={`template-${key}`} className="w-28" type="number" required min={min} max={max} step={step} value={config.retrieval[key]} onChange={event => setConfig({ ...config, retrieval: { ...config.retrieval, [key]: Number(event.target.value) } })} /></Field>)}
          <FieldDescription>语义阈值只过滤向量召回，关键词证据仍可返回。提高阈值可能遗漏资料。</FieldDescription>
        </FieldGroup>
      </details>
    </fieldset>
    <div className="flex shrink-0 justify-end"><Button type="submit" disabled={disabled}>{busy ? "正在保存…" : "保存模板"}</Button></div>
  </form>;
}
