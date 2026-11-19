"use client";
import { FileText, PencilLine, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { Button } from "@/components/ui/button";
import { isDocumentAttachment } from "@/lib/media/limits";
import { attachmentLabel } from "@/features/chat/draft";
import type { ChatState } from "@/features/chat/use-chat-state";

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
  if (!attachments.length && !isUploadingAttachments) return null;
  /*
   * One row of tiles the same height, an image as its thumbnail and a document as
   * its name and type. Each has its own remove in its corner, shown when it is
   * pointed at or reached by keyboard (always on a touch screen), so the row holds
   * nothing else; sending takes them all.
   */
  return (
    <ul className="composer-attachments" aria-label={t("chat.composer.attachmentListLabel")}>
      {attachments.map((attachment, index) => {
        const name = attachmentLabel(attachment);
        const document = isDocumentAttachment(attachment.mediaType);
        return <li className="composer-attachment group" key={`${attachment.url}-${index}`}>
          {document ? (
            <div className="composer-file" title={name}>
              <FileText aria-hidden="true" className="composer-file-icon" />
              <span className="composer-file-text">
                <span className="composer-file-name">{name}</span>
                <span className="composer-file-type">{attachment.mediaType === "application/pdf" ? "PDF" : "Word"}</span>
              </span>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- the asset lives behind the local credential, which a next/image loader would fetch without it.
            <img alt={name} title={name} className="composer-thumbnail" src={attachment.url} />
          )}
          <button aria-label={document ? tf("ui.chat.document-attachment.removeAttachment", { v0: name }) : t("chat.composer.removeAttachment")} className="composer-attachment-remove" onClick={() => removeAttachmentAt(index)} type="button">
            <X aria-hidden="true" />
          </button>
        </li>;
      })}
      {/* An upload under way holds its place in the row rather than adding a line under it. */}
      {isUploadingAttachments ? <li className="composer-attachment">
        <p className="composer-file composer-file-pending" role="status"><Spinner aria-hidden="true" className="size-3.5" /><span className="composer-file-name">{t("chat.composer.uploadingAttachment")}</span></p>
      </li> : null}
    </ul>
  );
}
