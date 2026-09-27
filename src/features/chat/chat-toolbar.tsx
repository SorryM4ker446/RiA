import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { imagePrompts, quickPrompts, videoPrompts } from "@/features/chat/page-utils";
import { Sparkles } from "lucide-react";
import type { ChatState } from "@/features/chat/use-chat-state";
import { t } from "@/lib/locale";

type Props = Pick<ChatState, "activeChat" | "isPending" | "modelMode" | "appendQuickPrompt">;
export function ChatToolbar({ activeChat, isPending, modelMode, appendQuickPrompt }: Props) {
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
