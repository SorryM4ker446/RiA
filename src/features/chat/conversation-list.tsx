import { Button } from "@/components/ui/button";
import Link from "next/link";
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
} from "lucide-react";
import { COLLAPSED_CHAT_LIMIT } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "isCreatingChat" | "createNewChat" | "chats" | "visibleChats" | "activeChatId" | "editingChatId" | "setEditingTitle" | "editingTitle" | "saveEditedTitle" | "cancelEditingChat" | "switchActiveChat" | "startEditingChat" | "requestDeleteConversation" | "hasHiddenChats" | "setIsChatListExpanded" | "isChatListExpanded" | "nextChatsCursor" | "isLoadingMoreChats" | "loadMoreChats">;
export function ConversationList({ isCreatingChat, createNewChat, chats, visibleChats, activeChatId, editingChatId, setEditingTitle, editingTitle, saveEditedTitle, cancelEditingChat, switchActiveChat, startEditingChat, requestDeleteConversation, hasHiddenChats, setIsChatListExpanded, isChatListExpanded, nextChatsCursor, isLoadingMoreChats, loadMoreChats }: Props) {
  return (<aside className="w-full shrink-0 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:w-72">
    <Card className="glass-surface flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden xl:max-h-[calc(100vh-5rem)]">
      <CardHeader className="shrink-0 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-primary" />
              会话列表
            </CardTitle>
            <CardDescription>置顶优先，按最近消息排序</CardDescription>
          </div>
          <div className="flex items-center gap-1">
              <Button
                aria-label="创建会话"
                disabled={isCreatingChat}
              onClick={() => void createNewChat()}
              size="sm"
              type="button"
            >
              {isCreatingChat ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>
        </div>
        <Link className="mt-2 text-sm text-primary underline underline-offset-4" href="/conversations">管理会话</Link>
        <Link className="mt-2 text-sm text-primary underline underline-offset-4" href="/media">媒体资源库</Link>
      </CardHeader>
      <CardContent className="chat-list-scroll min-h-0 space-y-2 overflow-y-auto overscroll-contain pr-3">
        {chats.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            还没有会话，点击右上角按钮创建第一个会话。
          </p>
        ) : (
          <>
            {visibleChats.map((chat) => {
              const isActive = activeChatId === chat.id;
              const isEditing = editingChatId === chat.id;

              return (
                <div
                  className={cn(
                    "rounded-lg border p-2.5 transition",
                    isActive ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40",
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
                          <Check className="mr-1 h-3.5 w-3.5" />
                          保存
                        </Button>
                        <Button onClick={cancelEditingChat} size="sm" type="button" variant="ghost">
                          <X className="mr-1 h-3.5 w-3.5" />
                          取消
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
                        <p className="truncate text-sm font-medium">{chat.pinned ? "📌 " : ""}{chat.title}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {chat.messageCount} 条消息 · {formatTime(chat.lastMessageAt)}
                        </p>
                      </button>
                      <div className="mt-2 flex items-center gap-1">
                        <Button
                          onClick={() => startEditingChat(chat)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <PencilLine className="mr-1 h-3.5 w-3.5" />
                          重命名
                        </Button>
                        <Button
                          onClick={() => requestDeleteConversation(chat)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          删除
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
                {isChatListExpanded ? "收起会话" : `展开更多（${chats.length - COLLAPSED_CHAT_LIMIT}）`}
              </Button>
            ) : null}
          </>
        )}
        {nextChatsCursor && (isChatListExpanded || !hasHiddenChats) ? (
          <Button className="w-full" disabled={isLoadingMoreChats} onClick={() => void loadMoreChats()} type="button" variant="secondary">
            {isLoadingMoreChats ? "加载中…" : "加载更多会话"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  </aside>);
}
