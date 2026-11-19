"use client";
import { useLocale } from "@/lib/locale/client";

import { useRef, useState } from "react";
import { useToastClearance } from "@/components/ui/toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChatHeader } from "@/features/chat/chat-toolbar";
import { Composer } from "@/features/chat/composer";
import { DeleteDialog } from "@/features/chat/delete-dialog";
import { MessageRenderer } from "@/features/chat/message-renderer";
import { RunRecords } from "@/features/chat/run-records";
import { ApprovalDock } from "@/features/chat/approval-dock";
import { DirectoryPermissions } from "@/features/chat/directory-permissions";
import { ComposerNotice } from "@/features/chat/composer-notice";
import { useChatState } from "@/features/chat/use-chat-state";
import { useChatCommands } from "@/features/commands/chat-commands";
import { TriangleAlert } from "lucide-react";
import { ToolLessModelNotice } from "@/features/chat/tool-less-model-notice";
import { localizeMessage, t } from "@/lib/locale";
import { PlanStrip } from "@/features/chat/task-plan";
import { useOpenSettings } from "@/features/settings/settings-context";

export default function ChatPage() {
  useLocale();
  const chat = useChatState();
  const openSettings = useOpenSettings();
  // Notes in the corner rise above the composer and the cards over it whenever they would cover them.
  const dock = useRef<HTMLDivElement>(null);
  useToastClearance(dock);
  const [executionPanel, setExecutionPanel] = useState<{ chatId: string; messageId?: string } | null>(null);
  // Commands from the palette and keyboard shortcuts; one sent from another page runs once chat is ready.
  useChatCommands(command => {
    if (command.type === "new-conversation") void chat.createNewChat();
    else if (command.type === "ask") void chat.askInNewChat(command.text);
    else if (command.type === "open-conversation") void chat.switchActiveChat(command.id);
    else if (command.type === "focus-composer") chat.textareaRef.current?.focus();
    else if (command.type === "select-model") { if (chat.modelMode !== "chat") chat.onModeSelect("chat"); chat.onModelSelect(command.model); }
    else if (command.type === "toggle-records") setExecutionPanel(previous => previous || !chat.activeChatId ? null : { chatId: chat.activeChatId });
  }, !chat.isLoadingChats);
  const showExecutionDetails = (messageId: string) => {
    if (chat.activeChatId) setExecutionPanel({ chatId: chat.activeChatId, messageId });
  };
  const {
    effectiveError,
    errorFix,
    setPageError,
    clearError,
    clearPreferencesError,
  } = chat;
  return (
    <main className="chat-workspace relative flex h-full min-h-0 w-full overflow-hidden">
      <ToolLessModelNotice {...chat} />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Card className="chat-canvas relative flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none">
          <ChatHeader {...chat} />

          <CardContent className="flex min-h-0 flex-1 flex-col gap-0 p-0">
            <MessageRenderer {...chat} onShowSources={showExecutionDetails} />

            {/* What the turn did, above the composer: the place someone looks
                when an answer mentions a task or a search they did not see. */}
            <div ref={dock} className="chat-dock flex max-h-[50%] shrink-0 flex-col gap-3 overflow-y-auto px-4 pb-5 pt-2 sm:px-7">
              {chat.isHistoryReady ? <ApprovalDock key={chat.activeChatId} {...chat} onDetails={showExecutionDetails} /> : null}
              {chat.isHistoryReady ? <PlanStrip messages={chat.messages} isPending={chat.isPending} /> : null}
              <div className="mx-auto flex w-full max-w-[42rem] flex-wrap items-center gap-1">
                {chat.modelMode === "chat" && chat.selectedModelInfo?.supportsTools !== false ? <DirectoryPermissions
                  workspaceGrantId={chat.activeChat?.workspaceGrantId ?? null}
                  locked={chat.isPending}
                  saving={chat.isWorkspaceSaving || chat.isLoadingChats}
                  onSelect={chat.setWorkspace}
                  // Withdrawing a folder clears it as a workspace on the server; reload so the picker says so.
                  onChange={() => { void chat.loadToolCatalog(); void chat.loadChats({ silent: true }); }}
                /> : null}
                {/* Records belong to a conversation known to exist, not one still being restored. */}
                <RunRecords
                  key={chat.confirmedChatId ?? "draft"}
                  messages={chat.isHistoryReady ? chat.messages : []}
                  open={!!chat.activeChatId && executionPanel?.chatId === chat.activeChatId}
                  focusedMessageId={executionPanel?.chatId === chat.activeChatId ? executionPanel.messageId : undefined}
                  onOpenChange={open => setExecutionPanel(previous => open && chat.activeChatId ? { chatId: chat.activeChatId, ...(previous?.chatId === chat.activeChatId ? { messageId: previous.messageId } : {}) } : null)}
                  activeChatId={chat.confirmedChatId}
                  refreshKey={chat.messages.length}
                />
              </div>

              <ComposerNotice modelHint={chat.modelHint} notice={chat.inputNotice} dimmed={chat.isModelMenuOpen} onChooseModel={() => chat.setIsModelMenuOpen(true)} onDismiss={chat.dismissInputNotice} />

              {/* As wide as the composer it sits on, not across the whole row. */}
              {effectiveError ? (
                <Alert variant="destructive" className="chat-error mx-auto w-full max-w-[42rem]">
                  <AlertTitle className="flex items-center gap-2">
                    <TriangleAlert aria-hidden="true" className="h-4 w-4" />
                    {t("chatPage.errorTitle")}
                  </AlertTitle>
                  <AlertDescription>
                    {/* Translated where it is shown, so an application message follows a language switch. */}
                    <p>{localizeMessage(effectiveError)}</p>
                  </AlertDescription>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {errorFix ? (
                      <Button size="sm" type="button" onClick={() => openSettings(errorFix === "apiKeys" ? "services" : "models")}>
                        {t(errorFix === "apiKeys" ? "chatPage.openApiKeys" : "chatPage.openModels")}
                      </Button>
                    ) : null}
                    <Button size="sm" type="button" variant="outline" onClick={() => { setPageError(null); clearError(); clearPreferencesError(); }}>
                      {t("chatPage.dismissError")}
                    </Button>
                  </div>
                </Alert>
              ) : null}

              <Composer {...chat} />
            </div>
          </CardContent>
        </Card>
      </section>

      <DeleteDialog {...chat} />
    </main>
  );
}
