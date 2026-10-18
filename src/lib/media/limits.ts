import { t } from "@/lib/locale";

export const MEDIA_LIMITS = {
  attachmentCount: 4,
  attachmentBytes: 8 * 1024 * 1024,
  totalAttachmentBytes: 20 * 1024 * 1024,
  uploadBodyBytes: 21 * 1024 * 1024,
  jsonBodyBytes: 2 * 1024 * 1024,
  generatedImageBytes: 20 * 1024 * 1024,
  generatedVideoBytes: 100 * 1024 * 1024,
  orphanGraceMs: 24 * 60 * 60 * 1000,
} as const;

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const DOCUMENT_ATTACHMENT_TYPES = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] as const;
export const CHAT_ATTACHMENT_TYPES = [...IMAGE_MEDIA_TYPES, ...DOCUMENT_ATTACHMENT_TYPES] as const;
export const CHAT_DOCUMENT_CHARACTERS = 100_000;

export function isDocumentAttachment(mediaType: string) {
  return (DOCUMENT_ATTACHMENT_TYPES as readonly string[]).includes(mediaType);
}

// Some Windows file pickers and drag sources supply no MIME type for Office files.
// This only normalizes a hint; the server also validates and parses the bytes.
export function attachmentMediaType(file: { type: string; name?: string }) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  if (/\.pdf$/i.test(file.name ?? "")) return DOCUMENT_ATTACHMENT_TYPES[0];
  if (/\.docx$/i.test(file.name ?? "")) return DOCUMENT_ATTACHMENT_TYPES[1];
  return file.type;
}

export function attachmentValidationError(files: Array<{ size: number; type: string; name?: string }>, allowDocuments = false): string | null {
  if (files.length > MEDIA_LIMITS.attachmentCount) return t("lib.media.tooManyAttachments");
  const types: readonly string[] = allowDocuments ? CHAT_ATTACHMENT_TYPES : IMAGE_MEDIA_TYPES;
  if (files.some((file) => !types.includes(allowDocuments ? attachmentMediaType(file) : file.type))) return t(allowDocuments ? "lib.media.unsupportedChatAttachmentType" : "lib.media.unsupportedAttachmentType");
  if (files.some((file) => file.size === 0 || file.size > MEDIA_LIMITS.attachmentBytes)) return t("lib.media.attachmentSize");
  if (files.reduce((sum, file) => sum + file.size, 0) > MEDIA_LIMITS.totalAttachmentBytes) return t("lib.media.totalAttachmentSize");
  return null;
}
