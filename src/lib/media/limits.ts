import { t } from "@/lib/locale";
import { MEDIA_LIMITS } from "./limits-constants";

export { MEDIA_LIMITS } from "./limits-constants";

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

/** Only a stored asset's server-owned kind can grant the generated-image size allowance. */
export function attachmentValidationError(files: Array<{ size: number; type: string; name?: string; kind?: string }>, allowDocuments = false): string | null {
  const count = allowDocuments ? MEDIA_LIMITS.attachmentCount : MEDIA_LIMITS.referenceCount;
  const size = allowDocuments ? MEDIA_LIMITS.totalAttachmentBytes : MEDIA_LIMITS.referenceBytes;
  if (files.length > count) return t(allowDocuments ? "lib.media.tooManyAttachments" : "server.attachment.tooManyImages");
  const types: readonly string[] = allowDocuments ? CHAT_ATTACHMENT_TYPES : IMAGE_MEDIA_TYPES;
  if (files.some((file) => !types.includes(allowDocuments ? attachmentMediaType(file) : file.type))) return t(allowDocuments ? "lib.media.unsupportedChatAttachmentType" : "lib.media.unsupportedAttachmentType");
  for (const file of files) {
    const generated = file.kind === "generated-image" && file.type.startsWith("image/");
    const limit = generated ? MEDIA_LIMITS.generatedImageBytes : MEDIA_LIMITS.attachmentBytes;
    if (file.size <= 0 || file.size > limit) return t(generated ? "lib.media.generatedImageAttachmentSize" : "lib.media.attachmentSize");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > size) return t(allowDocuments ? "lib.media.totalAttachmentSize" : "lib.media.referenceSize");
  return null;
}
