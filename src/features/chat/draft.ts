import { t } from "@/lib/locale";
import type { UploadableFilePart } from "@/features/chat/page-utils";

/**
 * An unsent message, kept per conversation.
 *
 * The text is small enough to keep as text. An attachment is not: the browser
 * cannot hand a file back after a reload, so the file is uploaded the moment it
 * is chosen and the draft keeps the reference the server already gave it. That
 * is what lets a draft survive a restart and still be sendable — and it is also
 * why the upload happens on selection rather than on send: waiting until send
 * would mean the file is only known at the last moment, which is exactly when
 * it cannot be recovered.
 *
 * An uploaded-but-never-sent attachment becomes an unreferenced file. The media
 * store already accounts for those: it keeps them for a grace period and
 * reclaims them, so an abandoned draft costs disk for a while and nothing more.
 */
export type ChatDraft = {
  text: string;
  attachments: UploadableFilePart[];
  updatedAt: number;
};

const DRAFT_KEY_PREFIX = "private-ai.chat.draft.";
const MAX_TEXT = 40_000;
const MAX_ATTACHMENTS = 4;
// A draft older than this is treated as abandoned: re-opening a week-old
// conversation should not silently put back a half-written question.
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

function getChatDraftKey(chatId: string) {
  return `${DRAFT_KEY_PREFIX}${chatId}`;
}

export function readChatDraft(chatId: string | null): ChatDraft | null {
  if (!chatId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(getChatDraftKey(chatId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatDraft>;
    const text = typeof parsed.text === "string" ? parsed.text.slice(0, MAX_TEXT) : "";
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(isUploadablePart).slice(0, MAX_ATTACHMENTS)
      : [];
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
    if (!text && attachments.length === 0) return null;
    if (Date.now() - updatedAt > MAX_AGE_MS) {
      clearChatDraft(chatId);
      return null;
    }
    return { text, attachments, updatedAt };
  } catch {
    // A corrupt entry is dropped rather than allowed to break the composer.
    return null;
  }
}

export function writeChatDraft(chatId: string | null, draft: Omit<ChatDraft, "updatedAt">) {
  if (!chatId || typeof window === "undefined") return;
  try {
    if (!draft.text && draft.attachments.length === 0) {
      window.localStorage.removeItem(getChatDraftKey(chatId));
      return;
    }
    const value: ChatDraft = {
      text: draft.text.slice(0, MAX_TEXT),
      attachments: draft.attachments.slice(0, MAX_ATTACHMENTS),
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(getChatDraftKey(chatId), JSON.stringify(value));
  } catch {
    // A full or unavailable store must not stop the user from typing.
  }
}

export function clearChatDraft(chatId: string | null) {
  if (!chatId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(getChatDraftKey(chatId));
  } catch {
    // Nothing to do: a draft that cannot be cleared is overwritten on the next write.
  }
}

function isUploadablePart(value: unknown): value is UploadableFilePart {
  if (!value || typeof value !== "object") return false;
  const part = value as { type?: unknown; url?: unknown; mediaType?: unknown };
  return part.type === "file" && typeof part.url === "string" && typeof part.mediaType === "string";
}

/** What the composer shows for an attachment that survived a restart. */
export function attachmentLabel(part: UploadableFilePart) {
  return part.filename?.trim() || t("mediaGen.untitledFile");
}
