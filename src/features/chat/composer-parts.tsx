"use client";
import { Loader2, PencilLine, X } from "lucide-react";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { Button } from "@/components/ui/button";
import { DocumentAttachment } from "@/components/chat/document-attachment";
import { isDocumentAttachment } from "@/lib/media/limits";
import { attachmentLabel } from "@/features/chat/draft";
import type { ChatState } from "@/features/chat/use-chat-state";

const REMOVE_BUTTON = [
  "absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-background",
  "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
].join(" ");

/** Written while the answer was still coming: sent in order once the conversation is free. */
export function QueuedMessages({ queuedMessages, queueHeldBy, editQueued, removeQueued }: Pick<ChatState, "queuedMessages" | "queueHeldBy" | "editQueued" | "removeQueued">) {
  useLocale();
  if (!queuedMessages.length) return null;
  return (
    <ol className="composer-queue" aria-label={t("chat.queue.label")}>
      {queuedMessages.map(item => (
        <li key={item.id} className="composer-queue-item">
          <span className="composer-queue-text truncate">{item.text || item.attachments.map(file => file.filename ?? "").join(t("chat.composer.attachmentSeparator"))}</span>
          <Button
            type="button" variant="ghost" size="icon-sm" className="composer-queue-action"
            aria-label={t("chat.queue.edit")} title={t("chat.queue.edit")} onClick={() => editQueued(item.id)}
          >
            <PencilLine aria-hidden="true" />
          </Button>
          <Button
            type="button" variant="ghost" size="icon-sm" className="composer-queue-action"
            aria-label={t("chat.queue.remove")} title={t("chat.queue.remove")} onClick={() => removeQueued(item.id)}
          >
            <X aria-hidden="true" />
          </Button>
        </li>
      ))}
      {queueHeldBy
        ? <li className="composer-queue-hint composer-queue-held" role="status">{tf(queueHeldBy.key, queueHeldBy.values ?? {})}</li>
        : <li className="composer-queue-hint">{t("chat.queue.hint")}</li>}
    </ol>
  );
}

/*
 * What is attached, and an upload still under way. A thumbnail is worth more
 * than a file name here: the user is deciding whether the right picture got
 * attached, and a name cannot answer that. Each one removes itself rather than
 * only offering "remove all", because fixing a wrong pick should not cost the
 * picks that were right.
 */
export function ComposerAttachments({ attachments, removeAttachmentAt, isUploadingAttachments }: Pick<ChatState, "attachments" | "removeAttachmentAt" | "isUploadingAttachments">) {
  useLocale();
  return (
    <>
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label={t("chat.composer.attachmentListLabel")}>
          {attachments.map((attachment, index) => isDocumentAttachment(attachment.mediaType) ? (
            <li className="w-56 max-w-full" key={attachment.url}>
              <DocumentAttachment {...attachment} onRemove={() => removeAttachmentAt(index)} />
            </li>
          ) : (
            <li className="group relative" key={`${attachment.url}-${index}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the asset
                lives behind the local credential, which a next/image loader
                would fetch without it. */}
              <img alt={attachmentLabel(attachment)} className="h-14 w-14 rounded-md border border-border object-cover" src={attachment.url} />
              <button
                aria-label={t("chat.composer.removeAttachment")}
                className={REMOVE_BUTTON}
                onClick={() => removeAttachmentAt(index)}
                type="button"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {isUploadingAttachments ? (
        <p className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-muted-foreground" role="status">
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
          {t("chat.composer.uploadingAttachment")}
        </p>
      ) : null}
    </>
  );
}
