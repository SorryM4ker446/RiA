"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChatToolbar } from "@/features/chat/chat-toolbar";
import { Composer } from "@/features/chat/composer";
import { ConversationList } from "@/features/chat/conversation-list";
import { DeleteDialog } from "@/features/chat/delete-dialog";
import { MessageRenderer } from "@/features/chat/message-renderer";
import { TaskPanel } from "@/features/chat/task-panel";
import { RunRecords } from "@/features/chat/run-records";
import { useChatState } from "@/features/chat/use-chat-state";
import { TriangleAlert } from "lucide-react";
import { t } from "@/lib/locale";

export default function ChatPage() {
  const chat = useChatState();
  const { effectiveError, keyError, setPageError, clearError, clearPreferencesError } = chat;
  return (
    /* items-stretch gives all three columns one height, so the rails stop
       floating at half height next to a taller chat. The page itself still
       scrolls: locking the frame to the viewport clips the message list and
       leaves its controls underneath the toolbar. */
    <main className="mx-auto flex w-full max-w-[100rem] flex-col gap-4 p-4 md:p-6 xl:flex-row xl:items-stretch xl:gap-5 xl:p-5">
      <ConversationList {...chat} />

      <section className="flex min-h-[calc(100vh-2.5rem)] min-w-0 flex-1 flex-col">
        <Card className="flex h-full flex-col overflow-hidden animate-panel-in-up">
          <ChatToolbar {...chat} />

          <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-4">
            <MessageRenderer {...chat} />

            {/* What the turn did, above the composer: the place someone looks
                when an answer mentions a task or a search they did not see. */}
            <RunRecords activeChatId={chat.activeChatId} refreshKey={chat.messages.length} />

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
          </CardContent>
        </Card>
      </section>

      <TaskPanel {...chat} />

      <DeleteDialog {...chat} />
    </main>
  );
}
