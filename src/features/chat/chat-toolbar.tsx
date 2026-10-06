import { useEffect } from "react";
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
}: Props) {
  // Topics are fetched once for the header; a failure only removes the scope
  // control, it does not affect the conversation.
  useEffect(() => {
    void loadDocumentTopics();
  }, [loadDocumentTopics]);

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
      {activeChat ? (
        <label title={t("chat.ephemeral.note")} className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            checked={activeChat.ephemeral === true}
            className="h-3.5 w-3.5 accent-current"
            disabled={isEphemeralSaving}
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
