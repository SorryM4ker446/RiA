import { Button } from "@/components/ui/button";
import { readText } from "@/features/chat/page-utils";
import { t, tf } from "@/lib/locale";
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
      className="dialog-overlay-enter fixed inset-0 z-[70] flex items-center justify-center bg-foreground/25 px-4 backdrop-blur-[2px]"
      onClick={closeDeleteDialog}
    >
      <div
        aria-modal="true"
        className="dialog-panel-enter w-full max-w-md rounded-lg bg-card p-5 shadow-raised"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-destructive/10 p-1.5 text-destructive">
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-label text-foreground">
              {pendingDelete.kind === "chat" ? t("chat.delete.titleChat") : t("chat.delete.titleMessage")}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {pendingDelete.kind === "chat"
                ? t("chat.delete.bodyChat")
                : t("chat.delete.bodyMessage")}
            </p>
            <p className="mt-2 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground/85">
              {pendingDelete.kind === "chat"
                ? pendingDelete.chat.title
                : tf("chat.delete.quoted", { text: readText(pendingDelete.message).slice(0, 60) || t("chat.delete.emptyMessage") })}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button disabled={isDeleting} onClick={closeDeleteDialog} size="sm" type="button" variant="ghost">
            {t("chat.common.cancel")}
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
                <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
                {t("chat.delete.deleting")}
              </>
            ) : (
              t("chat.delete.confirm")
            )}
          </Button>
        </div>
      </div>
    </div>
  ) : null);
}

