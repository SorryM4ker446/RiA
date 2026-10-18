import { SelectField, SelectOption } from "@/components/ui/select";
import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ChatState } from "@/features/chat/use-chat-state";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";
import { decodeDocumentScope } from "@/lib/documents/scope";
import { TemplateDetails } from "@/features/assistants/template-details";

type Props = Pick<
  ChatState,
  | "activeChat"
  | "isPending"
  | "isLoadingChats"
  | "isDocumentScopeSaving"
  | "modelMode"
  | "appendQuickPrompt"
  | "toggleEphemeral"
  | "isEphemeralSaving"
  | "documentTopics"
  | "setDocumentScope"
  | "loadDocumentTopics"
  | "assistants" | "assistantsError" | "loadAssistants" | "applyAssistant"
> & { conversationControls?: ReactNode };
export function ChatToolbar({
  activeChat,
  isPending,
  isLoadingChats,
  isDocumentScopeSaving,
  modelMode,
  toggleEphemeral,
  isEphemeralSaving,
  documentTopics,
  setDocumentScope,
  loadDocumentTopics,
  assistants, assistantsError, loadAssistants, applyAssistant,
  conversationControls,
}: Props) {
  // Topics are fetched once for the header; a failure only removes the scope
  // control, it does not affect the conversation.
  useEffect(() => {
    void loadDocumentTopics();
  }, [loadDocumentTopics]);
  useEffect(() => { const controller = new AbortController(); void loadAssistants(controller.signal); return () => controller.abort(); }, [loadAssistants]);
  const snapshot = activeChat?.assistantConfig;
  const currentTemplate = assistants.find(item => item.id === snapshot?.templateId);
  const hasTemplateUpdate = snapshot && currentTemplate && currentTemplate.revision !== snapshot.templateRevision;

  return (
    <CardHeader className="chat-toolbar max-h-[30%] shrink-0 gap-3 overflow-y-auto border-b px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {conversationControls}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <CardTitle className="min-w-0 truncate">{activeChat?.title ?? t("chat.toolbar.newChat")}</CardTitle>
          {isPending ? <>
            <Badge className="shrink-0" variant="outline">{t("chat.toolbar.statusGenerating")}</Badge>
            <CardDescription role="status" className="sr-only">{modelMode === "image" ? t("chat.toolbar.pendingImage") : modelMode === "video" ? t("chat.toolbar.pendingVideo") : t("chat.toolbar.pendingChat")}</CardDescription>
          </> : null}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="chat-assistant">助理模板</label>
          <SelectField id="chat-assistant" aria-label="助理模板" variant="ghost" size="sm" className="max-w-48" value={snapshot?.templateId ?? ""} disabled={!activeChat || isPending || isLoadingChats || isDocumentScopeSaving || isEphemeralSaving} onValueChange={value => void applyAssistant(value || null)}>
            <SelectOption value="">通用助理</SelectOption>
            {snapshot && !currentTemplate ? <SelectOption value={snapshot.templateId}>{snapshot.name}</SelectOption> : null}
            {assistants.map(item => <SelectOption key={item.id} value={item.id}>{item.config.name}</SelectOption>)}
          </SelectField>
          {snapshot ? <TemplateDetails key={activeChat?.id} snapshot={snapshot} /> : null}
          <Button asChild variant="ghost" size="sm"><Link href="/assistants">管理模板</Link></Button>
          {activeChat && <Button role="checkbox" aria-checked={activeChat.ephemeral === true} aria-label={t("chat.ephemeral.label")} title={t("chat.ephemeral.note")} className="chat-memory-toggle" variant="ghost" size="sm" disabled={isEphemeralSaving || isDocumentScopeSaving || isPending} onClick={() => void toggleEphemeral(!activeChat.ephemeral)}><ShieldOff data-icon="inline-start" aria-hidden="true" />{t("chat.ephemeral.label")}</Button>}
        </div>
      </div>
      {hasTemplateUpdate || assistantsError ? <div className="flex flex-wrap items-center gap-2 text-xs">
        {hasTemplateUpdate ? <Button variant="ghost" size="sm" disabled={isPending || isDocumentScopeSaving} onClick={() => void applyAssistant(snapshot.templateId)}>更新为最新模板</Button> : null}
        {assistantsError ? <span role="alert">{assistantsError} <Button variant="ghost" size="sm" onClick={() => void loadAssistants()}>重试</Button></span> : null}
      </div> : null}

      {/* What this conversation is allowed to draw on. Empty means every topic,
        which is why the control says so rather than looking unselected. */}
      {documentTopics.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t("chat.scope.label")}</span>
          <button
            aria-pressed={!(activeChat?.documentScope ?? "")}
            disabled={!activeChat || isLoadingChats || isDocumentScopeSaving || isPending}
            className={cn(
              "rounded-full border border-border px-2 py-0.5",
              !(activeChat?.documentScope ?? "") && "bg-accent text-foreground",
            )}
            onClick={() => void setDocumentScope([])}
            type="button"
          >
            {t("chat.scope.all")}
          </button>
          {documentTopics.map((topic) => {
            const current = decodeDocumentScope(activeChat?.documentScope);
            const selected = current.includes(topic);
            return (
              <button
                aria-pressed={selected}
                disabled={!activeChat || isLoadingChats || isDocumentScopeSaving || isPending}
                className={cn(
                  "rounded-full border border-border px-2 py-0.5",
                  selected && "bg-accent text-foreground",
                )}
                key={topic}
                onClick={() =>
                  void setDocumentScope(
                    selected
                      ? current.filter((item) => item !== topic)
                      : [...current, topic],
                  )
                }
                type="button"
              >
                {topic}
              </button>
            );
          })}
        </div>
      ) : null}
    </CardHeader>
  );
}
