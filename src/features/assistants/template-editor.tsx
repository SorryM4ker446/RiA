"use client";
import { useLocale } from "@/lib/locale/client";

import {  t, tf , localizeMessage } from "@/lib/locale";

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
  useLocale();
  const toolOptions = [...tools, ...config.tools.filter(id => !tools.some(tool => tool.id === id)).map(id => ({ id, displayName: tf("ui.assistants.template-editor.removedTool", { v0: id.slice(-8) }) }))];
  return <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
    <fieldset disabled={disabled} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
      <FieldGroup className="gap-4">
        <Field className="gap-2"><FieldLabel htmlFor="template-name">{t("ui.assistants.template-editor.templateName")}</FieldLabel><Input id="template-name" required maxLength={60} value={config.name} onChange={event => setConfig({ ...config, name: event.target.value })} /></Field>
        <Field className="gap-2"><FieldLabel htmlFor="template-description">{t("ui.assistants.template-editor.description")}</FieldLabel><Input id="template-description" maxLength={300} value={config.description} onChange={event => setConfig({ ...config, description: event.target.value })} /></Field>
        <Field className="gap-2"><FieldLabel htmlFor="template-instructions">{t("ui.assistants.template-details.assistantInstructions")}</FieldLabel><Textarea id="template-instructions" required maxLength={6000} className="min-h-32" value={config.instructions} onChange={event => setConfig({ ...config, instructions: event.target.value })} /></Field>
        <Field className="gap-2"><FieldLabel htmlFor="template-model">{t("ui.assistants.template-editor.assignedChatModel")}</FieldLabel><SelectField id="template-model" value={config.model ? modelRefKey(config.model) : ""} onValueChange={value => { const item = models.find(model => modelRefKey(model) === value); setConfig({ ...config, model: item ? { providerId: item.providerId, modelId: item.modelId } : null }); }}>
          <SelectOption value="">{t("ui.assistants.template-details.followConversationSetting")}</SelectOption>
          {config.model && !models.some(model => modelRefKey(model) === modelRefKey(config.model!)) ? <SelectOption value={modelRefKey(config.model)}>{t("ui.assistants.template-editor.removed")}{config.model.modelId}</SelectOption> : null}
          {models.map(model => <SelectOption key={modelRefKey(model)} value={modelRefKey(model)}>{model.name} · {model.providerId}</SelectOption>)}
        </SelectField></Field>
        <FieldSet className="gap-2"><FieldLegend variant="label">{t("ui.assistants.template-editor.availableTools")}</FieldLegend><FieldDescription>{t("ui.assistants.template-editor.onlySelectedToolsAreAllowedApprovals")}</FieldDescription>
          <FieldGroup className="grid grid-cols-1 gap-1 sm:grid-cols-2">{toolOptions.map(tool => <Field key={tool.id} orientation="horizontal" className="gap-2 rounded-md px-2 py-1.5"><input id={`template-tool-${tool.id}`} type="checkbox" className="size-3.5 shrink-0 accent-foreground" checked={config.tools.includes(tool.id)} onChange={event => setConfig({ ...config, tools: event.target.checked ? [...config.tools, tool.id] : config.tools.filter(id => id !== tool.id) })} /><FieldLabel htmlFor={`template-tool-${tool.id}`} className="min-w-0 break-words">{tool.id.startsWith("ext") ? tool.displayName : localizeMessage(tool.displayName)}</FieldLabel></Field>)}</FieldGroup>
        </FieldSet>
        <Field className="gap-2"><FieldLabel htmlFor="template-collections">{t("ui.assistants.template-editor.knowledgeCollectionsOnePerLineBlank")}</FieldLabel><Textarea id="template-collections" rows={2} maxLength={600} value={collections} onChange={event => setCollections(event.target.value)} /></Field>
        <Field orientation="horizontal" className="gap-2"><input id="template-memory" type="checkbox" className="size-3.5 accent-foreground" checked={config.usesMemory} onChange={event => setConfig({ ...config, usesMemory: event.target.checked })} /><FieldLabel htmlFor="template-memory">{t("ui.assistants.template-editor.useLongTermMemory")}</FieldLabel></Field>
      </FieldGroup>
      <details className="settings-disclosure">
        <summary className="settings-disclosure-trigger justify-between">{t("ui.assistants.template-editor.retrievalStrategy")}<ChevronDown className="size-4" aria-hidden="true" /></summary>
        <FieldGroup className="gap-3 pt-3">
          {([
            ["semanticThreshold", t("ui.knowledge.retrieval-diagnostics.semanticThreshold"), 0.1, 0.95, 0.05], ["maxSources", t("ui.assistants.template-editor.evidenceCount"), 1, 8, 1], ["contextChars", t("ui.assistants.template-editor.evidenceCharacterBudget"), 1200, 9600, 100],
          ] as const).map(([key, label, min, max, step]) => <Field orientation="horizontal" key={key} className="justify-between"><FieldLabel htmlFor={`template-${key}`}>{label}</FieldLabel><Input id={`template-${key}`} className="w-28" type="number" required min={min} max={max} step={step} value={config.retrieval[key]} onChange={event => setConfig({ ...config, retrieval: { ...config.retrieval, [key]: Number(event.target.value) } })} /></Field>)}
          <FieldDescription>{t("ui.assistants.template-editor.theSemanticThresholdOnlyFiltersVector")}</FieldDescription>
        </FieldGroup>
      </details>
    </fieldset>
    <div className="flex shrink-0 justify-end"><Button type="submit" disabled={disabled}>{busy ? t("ui.assistants.template-editor.saving") : t("ui.assistants.template-editor.saveTemplate")}</Button></div>
  </form>;
}
