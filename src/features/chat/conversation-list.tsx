import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { formatTime } from "@/features/chat/page-utils";
import { cn } from "@/lib/utils/cn";
import {
  Check,
  Loader2,
  MessageSquare,
  PencilLine,
  Plus,
  Trash2,
  X,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { COLLAPSED_CHAT_LIMIT } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";
import { t, tf } from "@/lib/locale";

type Props = Pick<
  ChatState,
  | "isLoadingChats"
  | "isCreatingChat"
  | "createNewChat"
  | "chats"
  | "visibleChats"
  | "activeChatId"
  | "editingChatId"
  | "setEditingTitle"
  | "editingTitle"
  | "saveEditedTitle"
  | "cancelEditingChat"
  | "switchActiveChat"
  | "startEditingChat"
  | "requestDeleteConversation"
  | "hasHiddenChats"
  | "setIsChatListExpanded"
  | "isChatListExpanded"
  | "nextChatsCursor"
  | "isLoadingMoreChats"
  | "loadMoreChats"
  | "panelVisibility"
  | "togglePanel"
>;
export function ConversationList({
  isLoadingChats,
  isCreatingChat,
  createNewChat,
  chats,
  visibleChats,
  activeChatId,
  editingChatId,
  setEditingTitle,
  editingTitle,
  saveEditedTitle,
  cancelEditingChat,
  switchActiveChat,
  startEditingChat,
  requestDeleteConversation,
  hasHiddenChats,
  setIsChatListExpanded,
  isChatListExpanded,
  nextChatsCursor,
  isLoadingMoreChats,
  loadMoreChats,
  panelVisibility,
  togglePanel,
}: Props) {
  const awaitingFirstLoad = useAwaitingFirstLoad(
    isLoadingChats,
    "conversations",
  );
  const railOpen = panelVisibility?.conversations !== false;
  return (
    <aside
      aria-label={t("chat.conversations.title")}
      data-open={railOpen}
      className={cn(
        "chat-rail chat-rail-left relative min-h-0 shrink-0 overflow-hidden border-r",
        railOpen ? "rail-expanded" : "rail-collapsed",
      )}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-4 flex justify-center",
          railOpen ? "hidden" : "w-10",
        )}
      >
        <Button
          aria-expanded={false}
          aria-label={t("chat.conversations.expandRail")}
          onClick={() => togglePanel("conversations")}
          variant="ghost"
          size="icon"
          className="h-7 w-7"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
      </div>
      <div
        inert={!railOpen}
        aria-hidden={!railOpen}
        className="conversation-rail-body flex h-full min-h-0 flex-col"
      >
        <header className="shrink-0 space-y-4 px-3 pb-3 pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-muted-foreground">
              {t("chat.conversations.recent")}
              <span className="ml-2 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                {chats.length}
              </span>
            </h2>
            <Button
              aria-expanded={railOpen}
              aria-label={t("chat.conversations.collapseRail")}
              onClick={() => togglePanel("conversations")}
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            aria-label={t("chat.conversations.create")}
            disabled={isCreatingChat}
            onClick={() => void createNewChat()}
            variant="outline"
            className="h-9 w-full justify-start gap-2 rounded-lg bg-card/50 text-xs shadow-none"
          >
            {isCreatingChat ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}{" "}
            {t("chat.toolbar.newChat")}
          </Button>
        </header>
        <div className="chat-list-scroll min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-2 pb-4">
          {awaitingFirstLoad ? (
            <div role="status" aria-label="加载会话" className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : chats.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground/40" />
              <p className="whitespace-pre-line text-xs leading-6 text-muted-foreground">
                {t("chat.conversations.empty")}
              </p>
            </div>
          ) : (
            visibleChats.map((chat) => {
              const isActive = activeChatId === chat.id;
              return (
                <div
                  key={chat.id}
                  className={cn(
                    "conversation-row group relative rounded-lg transition-colors",
                    isActive ? "bg-accent/80" : "hover:bg-accent/40",
                  )}
                >
                  {editingChatId === chat.id ? (
                    <div className="space-y-2 p-2">
                      <Input
                        autoFocus
                        aria-label={t("chat.conversations.rename")}
                        className="h-8 text-xs"
                        value={editingTitle}
                        onChange={(event) =>
                          setEditingTitle(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveEditedTitle(chat.id);
                          }
                          if (event.key === "Escape") cancelEditingChat();
                        }}
                      />
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => void saveEditedTitle(chat.id)}
                        >
                          <Check className="mr-1 h-3 w-3" />
                          {t("chat.common.save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={cancelEditingChat}
                        >
                          <X className="mr-1 h-3 w-3" />
                          {t("chat.common.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-current={isActive ? "true" : undefined}
                        className="block w-full rounded-lg px-3 py-3 pr-14 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => void switchActiveChat(chat.id)}
                      >
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate text-[13px] font-medium">
                            {chat.title}
                          </span>
                          {chat.pinned && (
                            <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
                          )}
                        </span>
                        <span className="mt-1.5 block truncate text-[11px] tabular-nums text-muted-foreground">
                          {formatTime(chat.lastMessageAt)}
                        </span>
                      </button>
                      <div className="conversation-actions absolute right-1 top-2 flex gap-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Button
                          aria-label={t("chat.conversations.rename")}
                          title={t("chat.conversations.rename")}
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => startEditingChat(chat)}
                        >
                          <PencilLine className="h-3 w-3" />
                        </Button>
                        <Button
                          aria-label={t("chat.common.delete")}
                          title={t("chat.common.delete")}
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => requestDeleteConversation(chat)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
          {hasHiddenChats && (
            <Button
              variant="ghost"
              className="mt-2 h-8 w-full text-xs text-muted-foreground"
              onClick={() => setIsChatListExpanded((previous) => !previous)}
            >
              {isChatListExpanded
                ? t("chat.conversations.collapse")
                : tf("chat.common.expandMore", {
                    count: chats.length - COLLAPSED_CHAT_LIMIT,
                  })}
            </Button>
          )}
          {nextChatsCursor && (isChatListExpanded || !hasHiddenChats) && (
            <Button
              variant="ghost"
              className="h-8 w-full text-xs"
              disabled={isLoadingMoreChats}
              onClick={() => void loadMoreChats()}
            >
              {t("chat.conversations.loadMore")}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
