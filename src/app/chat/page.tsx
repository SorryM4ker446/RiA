"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChatToolbar } from "@/features/chat/chat-toolbar";
import { Composer } from "@/features/chat/composer";
import { ConversationList } from "@/features/chat/conversation-list";
import { DeleteDialog } from "@/features/chat/delete-dialog";
import { MessageRenderer } from "@/features/chat/message-renderer";
import { RunRecords } from "@/features/chat/run-records";
import { DirectoryPermissions } from "@/features/chat/directory-permissions";
import { useChatState } from "@/features/chat/use-chat-state";
import { TriangleAlert } from "lucide-react";
import { t } from "@/lib/locale";

export default function ChatPage() {
  const chat = useChatState();
  const {
    effectiveError,
    keyError,
    setPageError,
    clearError,
    clearPreferencesError,
  } = chat;
  return (
    <main className="chat-workspace relative flex h-full min-h-0 w-full overflow-hidden">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Card className="chat-canvas relative flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none">
          <ChatToolbar {...chat} conversationControls={<ConversationList {...chat} />} />

          <CardContent className="flex min-h-0 flex-1 flex-col gap-0 p-0">
            <MessageRenderer {...chat} />

            {/* What the turn did, above the composer: the place someone looks
                when an answer mentions a task or a search they did not see. */}
            <div className="chat-dock flex max-h-[50%] shrink-0 flex-col gap-3 overflow-y-auto px-4 pb-5 pt-2 sm:px-7">
              <div className="mx-auto flex w-full max-w-[42rem] flex-wrap items-center gap-1">
                <RunRecords
                  activeChatId={chat.activeChatId}
                  refreshKey={chat.messages.length}
                />
                {chat.modelMode === "chat" ? <DirectoryPermissions onChange={() => void chat.loadToolCatalog()} /> : null}
              </div>

              {effectiveError ? (
                <Alert variant="destructive">
                  <AlertTitle className="flex items-center gap-2">
                    <TriangleAlert aria-hidden="true" className="h-4 w-4" />
                    {t("chatPage.errorTitle")}
                  </AlertTitle>
                  <AlertDescription>
                    <p>{effectiveError}</p>
                    {keyError ? (
                      <p className="mt-1">{t("chatPage.keyErrorHint")}</p>
                    ) : null}
                  </AlertDescription>
                  <div className="mt-2">
                    <Button
                      onClick={() => {
                        setPageError(null);
                        clearError();
                        clearPreferencesError();
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
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
