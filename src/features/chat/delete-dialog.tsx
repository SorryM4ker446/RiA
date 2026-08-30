import { Button } from "@/components/ui/button";
import { readText } from "@/features/chat/page-utils";
import {
  Loader2,
  Trash2
} from "lucide-react";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "pendingDelete" | "isDeleting" | "closeDeleteDialog" | "confirmDelete">;
export function DeleteDialog({ pendingDelete, isDeleting, closeDeleteDialog, confirmDelete }: Props) {
  return (pendingDelete ? (
    <div
      aria-hidden={isDeleting}
      className="dialog-overlay-enter fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[2px]"
      onClick={closeDeleteDialog}
    >
      <div
        aria-modal="true"
        className="dialog-panel-enter w-full max-w-md rounded-xl border border-border/80 bg-card p-5 shadow-2xl shadow-black/40"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 rounded-full border border-red-500/35 bg-red-500/12 p-1.5 text-red-500 dark:text-red-300">
            <Trash2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {pendingDelete.kind === "chat" ? "确认删除会话" : "确认删除消息"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingDelete.kind === "chat"
                ? "删除后将无法恢复。将移除会话及其全部消息记录。"
                : "删除后将无法恢复。"}
            </p>
            <p className="mt-2 truncate rounded-md border border-border/80 bg-muted/40 px-2 py-1 text-xs text-foreground/85">
              {pendingDelete.kind === "chat"
                ? pendingDelete.chat.title
                : `「${readText(pendingDelete.message).slice(0, 60) || "（空消息）"}」`}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button disabled={isDeleting} onClick={closeDeleteDialog} size="sm" type="button" variant="ghost">
            取消
          </Button>
          <Button
            disabled={isDeleting}
            onClick={() => void confirmDelete()}
            size="sm"
            type="button"
            variant="destructive"
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                删除中...
              </>
            ) : (
              "确认删除"
            )}
          </Button>
        </div>
      </div>
    </div>
  ) : null);
}

