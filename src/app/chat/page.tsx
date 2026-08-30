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
import { useChatState } from "@/features/chat/use-chat-state";
import {
  BookOpen,
  Settings,
  TriangleAlert
} from "lucide-react";
import Link from "next/link";
export default function ChatPage() {
  const chat = useChatState();
  const { isDesktopRuntime, effectiveError, keyError, setPageError, clearError } = chat;
  return (<>
    <div className="fixed left-4 top-6 z-50 flex items-center gap-2 md:left-6">
      <Link
        className="inline-flex h-9 items-center justify-center rounded-md border border-border/80 bg-card px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted/70"
        href="/knowledge"
      >
        <BookOpen className="mr-2 h-4 w-4 text-primary" />
        知识库
      </Link>
      <Link className="inline-flex h-9 items-center rounded-md border border-border/80 bg-card px-3 text-sm font-medium hover:bg-muted/70" href="/storage">存储管理</Link>
      {isDesktopRuntime ? (
        <Link
          className="inline-flex h-9 items-center justify-center rounded-md border border-border/80 bg-card px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted/70"
          href="/settings"
        >
          <Settings className="mr-2 h-4 w-4 text-primary" />
          设置
        </Link>
      ) : null}
    </div>

    <main className="mx-auto flex min-h-screen w-full max-w-[96rem] flex-col gap-4 p-4 md:p-6 xl:flex-row xl:items-start">
      <ConversationList {...chat} />

      <section className="flex min-h-[80vh] min-w-0 flex-1 flex-col">
        <Card className="glass-surface flex h-full flex-col overflow-hidden">
          <ChatToolbar {...chat} />

          <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-4">
            <MessageRenderer {...chat} />

            {effectiveError ? (
              <Alert variant="destructive">
                <AlertTitle className="flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4" />
                  请求失败
                </AlertTitle>
                <AlertDescription>
                  <p>{effectiveError}</p>
                  {keyError ? (
                    <p className="mt-1">
                      检查 `.env` 中 `OPENROUTER_API_KEY` 是否已填写，并重启 `npm run dev`。
                    </p>
                  ) : null}
                </AlertDescription>
                <div className="mt-2">
                  <Button
                    onClick={() => {
                      setPageError(null);
                      clearError();
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    关闭提示
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
  </>
  );
}
