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
import { useChatState } from "@/features/chat/use-chat-state";
import { TriangleAlert } from "lucide-react";
import { t } from "@/lib/locale";
import { useEffect, useState } from "react";
import { MessagesSquare, X } from "lucide-react";

export default function ChatPage() {
  const chat = useChatState();
  const [mobilePanel, setMobilePanel] = useState<"conversations" | null>(null);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1280px)");
    const close = () => setMobilePanel(null);
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  const togglePanel: typeof chat.togglePanel = (panel) => {
    if (mobilePanel === panel) setMobilePanel(null);
    else chat.togglePanel(panel);
  };
  const {
    effectiveError,
    keyError,
    setPageError,
    clearError,
    clearPreferencesError,
  } = chat;
  return (
    <main
      data-mobile-panel={mobilePanel ?? ""}
      onKeyDown={(event) => {
        if (event.key === "Escape") setMobilePanel(null);
      }}
      className="chat-workspace relative flex h-full min-h-0 w-full overflow-hidden"
    >
      <div className="chat-mobile-controls absolute inset-x-0 top-0 z-20 flex h-10 items-center justify-between border-b px-3 xl:hidden">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={mobilePanel === "conversations"}
          onClick={() =>
            setMobilePanel((current) =>
              current === "conversations" ? null : "conversations",
            )
          }
        >
          <MessagesSquare className="mr-2 h-4 w-4" />
          {t("chat.conversations.title")}
        </Button>
      </div>
      {mobilePanel ? (
        <button
          className="absolute inset-0 top-10 z-10 bg-background/60 backdrop-blur-sm xl:hidden"
          aria-label="关闭侧栏"
          onClick={() => setMobilePanel(null)}
        >
          <X className="absolute right-3 top-3 h-4 w-4" />
        </button>
      ) : null}
      <ConversationList
        {...chat}
        togglePanel={togglePanel}
        panelVisibility={
          mobilePanel === "conversations"
            ? { ...chat.panelVisibility, conversations: true }
            : chat.panelVisibility
        }
        switchActiveChat={async (id) => {
          setMobilePanel(null);
          await chat.switchActiveChat(id);
        }}
      />

      <section
        inert={mobilePanel !== null}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <Card className="chat-canvas relative flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-transparent shadow-none">
          <ChatToolbar {...chat} />

          <CardContent className="flex min-h-0 flex-1 flex-col gap-0 p-0">
            <MessageRenderer {...chat} />

            {/* What the turn did, above the composer: the place someone looks
                when an answer mentions a task or a search they did not see. */}
            <div className="chat-dock max-h-[50%] shrink-0 space-y-2 overflow-y-auto px-4 pb-4 pt-2 sm:px-6">
              <RunRecords
                activeChatId={chat.activeChatId}
                refreshKey={chat.messages.length}
              />

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
