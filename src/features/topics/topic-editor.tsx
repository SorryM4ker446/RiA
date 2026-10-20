"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantTemplate } from "@/lib/assistants/schema";
import { topicConfigSchema, type TopicConfig } from "@/lib/topics/schema";

export function TopicEditor({ initial, collections, assistants, busy, save, cancel }: { initial: TopicConfig; collections: string[]; assistants: AssistantTemplate[]; busy: boolean; save: (config: TopicConfig) => Promise<void>; cancel?: () => void }) {
  useLocale();
  const [config, setConfig] = useState(initial); const [custom, setCustom] = useState(""); const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); const parsed = topicConfigSchema.safeParse(config);
    if (!parsed.success) { setError(t("ui.topics.topic-editor.enterATopicNameAndSelect")); return; }
    setError(""); await save(parsed.data);
  }
  const names = [...new Set([...collections, ...config.collections])].sort();
  return <form className="space-y-3" onSubmit={event => void submit(event)}>
    <label className="block space-y-1 text-sm">{t("ui.topics.topic-editor.topicName")}<Input aria-label={t("ui.topics.topic-editor.topicName")} disabled={busy} maxLength={60} value={config.name} onChange={event => setConfig({ ...config, name: event.target.value })} required /></label>
    <label className="block space-y-1 text-sm">{t("ui.topics.topic-editor.topicDescription")}<Textarea aria-label={t("ui.topics.topic-editor.topicDescription")} disabled={busy} maxLength={500} value={config.description} onChange={event => setConfig({ ...config, description: event.target.value })} /></label>
    <fieldset disabled={busy} className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm">{t("ui.topics.topic-editor.topicCollections")}</legend>
      <p className="text-xs text-muted-foreground">{t("ui.topics.topic-editor.onlySelectedCollectionsAreUsedCollections")}</p>
      <div className="flex max-h-48 flex-wrap gap-3 overflow-y-auto">{names.map(name => <label className="flex min-w-0 items-center gap-1 break-all text-sm" key={name}><input type="checkbox" checked={config.collections.includes(name)} onChange={event => setConfig({ ...config, collections: event.target.checked ? [...config.collections, name] : config.collections.filter(value => value !== name) })} />{name}</label>)}</div>
      <div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" aria-label={t("ui.topics.topic-editor.addKnowledgeCollection")} maxLength={40} value={custom} onChange={event => setCustom(event.target.value)} /><Button type="button" variant="outline" disabled={!custom.trim() || config.collections.length >= 12} onClick={() => { setConfig({ ...config, collections: [...new Set([...config.collections, custom.trim()])] }); setCustom(""); }}>{t("ui.topics.topic-editor.addCollection")}</Button></div>
    </fieldset>
    <label className="block space-y-1 text-sm">{t("ui.topics.topic-editor.defaultAssistantTemplate")}<SelectField aria-label={t("ui.topics.topic-editor.defaultAssistantTemplate")} className="w-full rounded-md border bg-background p-2" disabled={busy} value={config.assistantTemplateId ?? ""} onValueChange={value => setConfig({ ...config, assistantTemplateId: value || null })}>
      <SelectOption value="">{t("ui.topics.topic-editor.useCurrentDefaultChatModel")}</SelectOption>{assistants.map(assistant => <SelectOption value={assistant.id} key={assistant.id}>{assistant.builtin ? localizeMessage(assistant.config.name) : assistant.config.name}</SelectOption>)}
      {config.assistantTemplateId && !assistants.some(assistant => assistant.id === config.assistantTemplateId) ? <SelectOption value={config.assistantTemplateId}>{t("ui.topics.topic-editor.originalTemplateUnavailableSelectAnother")}</SelectOption> : null}
    </SelectField></label>
    {error ? <p role="alert" className="text-sm text-destructive">{localizeMessage(error)}</p> : null}
    <div className="flex gap-2"><Button disabled={busy} type="submit">{t("ui.topics.topic-editor.saveTopic")}</Button>{cancel ? <Button disabled={busy} variant="outline" type="button" onClick={cancel}>{t("ui.topics.topic-editor.cancelEditing")}</Button> : null}</div>
  </form>;
}
