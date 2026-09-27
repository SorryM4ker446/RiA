import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatTime } from "@/features/chat/page-utils";
import { cn } from "@/lib/utils/cn";
import {
  Check,
  Loader2,
  MessageSquare,
  PencilLine,
  Plus,
  Trash2,
  X
, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { COLLAPSED_CHAT_LIMIT } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";
import { t, tf } from "@/lib/locale";

type Props = Pick<ChatState, "isCreatingChat" | "createNewChat" | "chats" | "visibleChats" | "activeChatId" | "editingChatId" | "setEditingTitle" | "editingTitle" | "saveEditedTitle" | "cancelEditingChat" | "switchActiveChat" | "startEditingChat" | "requestDeleteConversation" | "hasHiddenChats" | "setIsChatListExpanded" | "isChatListExpanded" | "nextChatsCursor" | "isLoadingMoreChats" | "loadMoreChats" | "panelVisibility" | "togglePanel">;
export function ConversationList({ isCreatingChat, createNewChat, chats, visibleChats, activeChatId, editingChatId, setEditingTitle, editingTitle, saveEditedTitle, cancelEditingChat, switchActiveChat, startEditingChat, requestDeleteConversation, hasHiddenChats, setIsChatListExpanded, isChatListExpanded, nextChatsCursor, isLoadingMoreChats, loadMoreChats, panelVisibility, togglePanel }: Props) {
  const railOpen = panelVisibility?.conversations !== false;
  return (<aside
    aria-label={t("chat.conversations.title")}
    className={cn(
      "w-full shrink-0 xl:sticky xl:top-[3.75rem] xl:flex xl:max-h-[calc(100vh-5rem)] xl:flex-col xl:overflow-y-auto xl:overscroll-contain xl:animate-panel-in-left",
      // The width is animated so the rail collapses into and out of its
      // expander instead of jumping; the chat column grows into the space it
      // hands back during the same transition.
      "xl:transition-[width] xl:duration-[--dur-base] xl:ease-[--ease-out]",
      railOpen ? "xl:w-[16.5rem]" : "xl:w-12",
    )}
  >
    {/*
      Collapsed, the rail keeps only its expander so the toggle never moves and
      the chat column claims the reclaimed width.
    */}
    {!railOpen ? (
      <div className="hidden xl:flex xl:flex-col xl:items-center xl:gap-2 xl:pt-5">
        <Button
          aria-expanded={false}
          aria-label={t("chat.conversations.expandRail")}
          className="h-7 w-7 px-0"
          onClick={() => togglePanel("conversations")}
          size="icon"
          title={t("chat.conversations.expandRail")}
          type="button"
          variant="ghost"
        >
          <PanelLeftOpen aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    ) : (
    <>
    {/*
      The rail is a column, not a floating card. A rounded card stretched to the
      chat column's height leaves a large void under short content and reads as
      an unfinished panel; a hairline rule reads as deliberate structure.
    */}
    <Card className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-none border-0 border-r border-border bg-transparent shadow-none xl:max-h-[calc(100vh-2.5rem)] xl:flex-1 xl:pr-5">
      <CardHeader className="shrink-0 border-b pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base tracking-title">
              <MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{t("chat.conversations.title")}</span>
            </CardTitle>
            <CardDescription>{t("chat.conversations.subtitle")}</CardDescription>
          </div>
          {/* Both rail controls sit together on the trailing edge. Splitting
              them across the row left the create button marooned in the middle
              with the collapse toggle adrift at the far right. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              aria-label={t("chat.conversations.create")}
              className="h-7 w-7 px-0"
              disabled={isCreatingChat}
              onClick={() => void createNewChat()}
              size="icon"
              type="button"
            >
              {isCreatingChat ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Plus aria-hidden="true" className="h-3.5 w-3.5" />}
            </Button>
            <Button
              aria-expanded={railOpen}
              aria-label={t(railOpen ? "chat.conversations.collapseRail" : "chat.conversations.expandRail")}
              className="h-7 w-7 shrink-0 px-0"
              onClick={() => togglePanel("conversations")}
              size="icon"
              title={t(railOpen ? "chat.conversations.collapseRail" : "chat.conversations.expandRail")}
              type="button"
              variant="ghost"
            >
              {railOpen ? <PanelLeftClose aria-hidden="true" className="h-3.5 w-3.5" /> : <PanelLeftOpen aria-hidden="true" className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="chat-list-scroll min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-3">
        {chats.length === 0 ? (
          <p className="empty-state !p-3 !text-left text-[13px]">
            {t("chat.conversations.empty")}
          </p>
        ) : (
          <>
            {visibleChats.map((chat) => {
              const isActive = activeChatId === chat.id;
              const isEditing = editingChatId === chat.id;

              return (
                <div
                  className={cn(
                    "animate-row-in rounded-lg p-2.5",
                    "transition-[background-color,color] duration-[--dur-fast] ease-[--ease-out]",
                    isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  )}
                  key={chat.id}
                >
                  {isEditing ? (
                    <div className="space-y-2">
                      <Input
                        autoFocus
                        onChange={(event) => setEditingTitle(event.target.value)}
                        value={editingTitle}
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          onClick={() => void saveEditedTitle(chat.id)}
                          size="sm"
                          type="button"
                          variant="default"
                        >
                          <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                          {t("chat.common.save")}
                        </Button>
                        <Button onClick={cancelEditingChat} size="sm" type="button" variant="ghost">
                          <X aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                          {t("chat.common.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        className="w-full text-left"
                        onClick={() => void switchActiveChat(chat.id)}
                        type="button"
                      >
                        <p className="truncate text-sm font-medium tracking-label">{chat.pinned ? "📌 " : ""}{chat.title}</p>
                        <p className="label-mono mt-1">
                          {chat.messageCount} {t("chat.conversations.messageCountUnit")} · {formatTime(chat.lastMessageAt)}
                        </p>
                      </button>
                      <div className="mt-2 flex items-center gap-1">
                        <Button
                          onClick={() => startEditingChat(chat)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <PencilLine aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                          {t("chat.conversations.rename")}
                        </Button>
                        <Button
                          onClick={() => requestDeleteConversation(chat)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                          {t("chat.common.delete")}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {hasHiddenChats ? (
              <Button
                className="w-full"
                onClick={() => setIsChatListExpanded((prev) => !prev)}
                type="button"
                variant="secondary"
              >
                {isChatListExpanded ? t("chat.conversations.collapse") : tf("chat.common.expandMore", { count: chats.length - COLLAPSED_CHAT_LIMIT })}
              </Button>
            ) : null}
          </>
        )}
        {/* The label must not change to "加载中…" while the request runs: the
            button would resize under the pointer and the list below would jump.
            Disabling it is enough feedback, and the rows stay put. */}
        {nextChatsCursor && (isChatListExpanded || !hasHiddenChats) ? (
          <Button className="w-full" disabled={isLoadingMoreChats} onClick={() => void loadMoreChats()} type="button" variant="secondary">
            {t("chat.conversations.loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
    </>
  )}
  </aside>);
}
