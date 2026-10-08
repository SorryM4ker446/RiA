import { useEffect } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChatState } from "@/features/chat/use-chat-state";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";
import { decodeDocumentScope } from "@/lib/documents/scope";

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
>;
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
}: Props) {
  // Topics are fetched once for the header; a failure only removes the scope
  // control, it does not affect the conversation.
  useEffect(() => {
    void loadDocumentTopics();
  }, [loadDocumentTopics]);
  useEffect(() => { const controller = new AbortController(); void loadAssistants(controller.signal); return () => controller.abort(); }, [loadAssistants]);
  const snapshot = activeChat?.assistantConfig;
  const currentTemplate = assistants.find(item => item.id === snapshot?.templateId);

  return (
    <CardHeader className="chat-toolbar max-h-[30%] shrink-0 space-y-3 overflow-y-auto border-b px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-sm tracking-title">
            {activeChat?.title ?? t("chat.toolbar.newChat")}
          </CardTitle>
          {isPending && <CardDescription className="text-xs">
            {isPending
              ? modelMode === "image"
                ? t("chat.toolbar.pendingImage")
                : modelMode === "video"
                  ? t("chat.toolbar.pendingVideo")
                  : t("chat.toolbar.pendingChat")
              : modelMode === "image"
                ? t("chat.toolbar.hintImage")
                : modelMode === "video"
                  ? t("chat.toolbar.hintVideo")
                  : t("chat.toolbar.hintChat")}
          </CardDescription>}
        </div>
        <div className="flex items-center gap-2">
          {isPending && <Badge variant="outline">{t("chat.toolbar.statusGenerating")}</Badge>}
        </div>
      </div>
      {/* A switch on memory, with its limits stated where it is set: a
        conversation that keeps its messages and uploads is not "nothing is
        stored", and saying otherwise here would be the wrong kind of promise. */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="chat-assistant">助理模板</label>
        <select id="chat-assistant" aria-label="助理模板" className="max-w-full rounded-md border bg-background px-2 py-1" value={snapshot?.templateId ?? ""} disabled={!activeChat || isPending || isLoadingChats || isDocumentScopeSaving || isEphemeralSaving} onChange={event => void applyAssistant(event.target.value || null)}>
          <option value="">通用助理</option>
          {snapshot && !currentTemplate ? <option value={snapshot.templateId}>{snapshot.name}（会话快照）</option> : null}
          {assistants.map(item => <option key={item.id} value={item.id}>{item.config.name}</option>)}
        </select>
        <Link className="underline underline-offset-2" href="/assistants">管理模板</Link>
        {snapshot ? <span className="text-muted-foreground">快照 v{snapshot.templateRevision} · {snapshot.tools.length} 个工具{snapshot.model ? ` · ${snapshot.model.modelId}` : ""}</span> : null}
        {snapshot && currentTemplate && currentTemplate.revision !== snapshot.templateRevision ? <button type="button" className="underline" disabled={isPending || isDocumentScopeSaving} onClick={() => void applyAssistant(snapshot.templateId)}>更新为最新模板</button> : null}
        {assistantsError ? <span role="alert">{assistantsError} <button type="button" className="underline" onClick={() => void loadAssistants()}>重试</button></span> : null}
      </div>
      {activeChat ? (
        <label title={t("chat.ephemeral.note")} className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            checked={activeChat.ephemeral === true}
            className="h-3.5 w-3.5 accent-current"
            disabled={isEphemeralSaving || isDocumentScopeSaving || isPending}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              void toggleEphemeral(event.target.checked === true)
            }
            type="checkbox"
          />
          <span>
            {t("chat.ephemeral.label")}
          </span>
        </label>
      ) : null}

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
