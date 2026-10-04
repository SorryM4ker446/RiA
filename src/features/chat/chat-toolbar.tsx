import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { imagePrompts, quickPrompts, videoPrompts } from "@/features/chat/page-utils";
import { Sparkles } from "lucide-react";
import type { ChatState } from "@/features/chat/use-chat-state";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";
import { decodeDocumentScope } from "@/lib/documents/scope";

type Props = Pick<ChatState, "activeChat" | "isPending" | "modelMode" | "appendQuickPrompt" | "toggleEphemeral" | "isEphemeralSaving" | "documentTopics" | "setDocumentScope" | "loadDocumentTopics">;
export function ChatToolbar({ activeChat, isPending, modelMode, appendQuickPrompt, toggleEphemeral, isEphemeralSaving, documentTopics, setDocumentScope, loadDocumentTopics }: Props) {
  // Topics are fetched once for the header; a failure only removes the scope
  // control, it does not affect the conversation.
  useEffect(() => { void loadDocumentTopics(); }, [loadDocumentTopics]);

  return (<CardHeader className="shrink-0 space-y-3 border-b pb-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base tracking-title">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          {activeChat?.title ?? t("chat.toolbar.newChat")}
        </CardTitle>
        <CardDescription>
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
        </CardDescription>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={isPending ? "warning" : "success"}>
          {isPending ? t("chat.toolbar.statusGenerating") : t("chat.toolbar.statusReady")}
        </Badge>
        <Badge variant="outline">
          {modelMode === "chat" ? t("chat.toolbar.kindChat") : modelMode === "image" ? t("chat.toolbar.kindImage") : t("chat.toolbar.kindVideo")}
        </Badge>
      </div>
    </div>
    {/* A switch on memory, with its limits stated where it is set: a
        conversation that keeps its messages and uploads is not "nothing is
        stored", and saying otherwise here would be the wrong kind of promise. */}
    {activeChat ? (
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          checked={activeChat.ephemeral === true}
          className="mt-0.5 h-3.5 w-3.5"
          disabled={isEphemeralSaving}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => void toggleEphemeral(event.target.checked === true)}
          type="checkbox"
        />
        <span>
          {t("chat.ephemeral.label")}
          <span className="block">{t("chat.ephemeral.note")}</span>
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
          className={cn("rounded-full border border-border px-2 py-0.5", !(activeChat?.documentScope ?? "") && "bg-accent text-foreground")}
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
              className={cn("rounded-full border border-border px-2 py-0.5", selected && "bg-accent text-foreground")}
              key={topic}
              onClick={() => void setDocumentScope(selected ? current.filter((item) => item !== topic) : [...current, topic])}
              type="button"
            >
              {topic}
            </button>
          );
        })}
      </div>
    ) : null}

    <div className="flex flex-wrap gap-2">
      {(modelMode === "chat"
        ? quickPrompts
        : modelMode === "image"
          ? imagePrompts
          : videoPrompts
      ).map((prompt) => (
        <Button
          className="h-7 px-2.5 text-[11px] font-normal"
          key={prompt}
          onClick={() => appendQuickPrompt(prompt)}
          type="button"
          variant="secondary"
        >
          {prompt}
        </Button>
      ))}
    </div>
  </CardHeader>);
}
