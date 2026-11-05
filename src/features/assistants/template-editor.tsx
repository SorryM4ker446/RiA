"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TemplateTools } from "@/features/assistants/template-tools";
import type { ToolCatalogItem } from "@/features/chat/types";
import type { AssistantConfig } from "@/lib/assistants/schema";
import { modelRefKey, type ModelLibraryItem } from "@/lib/models/preferences-schema";

type Props = {
  config: AssistantConfig;
  setConfig: Dispatch<SetStateAction<AssistantConfig>>;
  collections: string;
  setCollections: (value: string) => void;
  models: ModelLibraryItem[];
  tools: ToolCatalogItem[];
  disabled: boolean;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
};

export function TemplateEditor({ config, setConfig, collections, setCollections, models, tools, disabled, busy, onSubmit }: Props) {
  useLocale();
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
        <TemplateTools tools={tools} value={config.tools} onChange={next => setConfig({ ...config, tools: next })} />
        <Field className="gap-2"><FieldLabel htmlFor="template-collections">{t("ui.assistants.template-editor.knowledgeCollectionsOnePerLineBlank")}</FieldLabel><Textarea id="template-collections" rows={2} maxLength={600} value={collections} onChange={event => setCollections(event.target.value)} />{collections.trim() && !config.tools.includes("searchKnowledge") ? <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><FieldDescription>{t("ui.assistants.template-editor.collectionsNeedSearch")}</FieldDescription><Button type="button" size="sm" variant="secondary" onClick={() => setConfig({ ...config, tools: [...config.tools, "searchKnowledge"] })}>{t("ui.assistants.template-editor.enableSearch")}</Button></div> : null}</Field>
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
