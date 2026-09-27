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

export function attachmentValidationError(files: Array<{ size: number; type: string }>): string | null {
  if (files.length > MEDIA_LIMITS.attachmentCount) return t("lib.media.tooManyAttachments");
  if (files.some((file) => !(IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type))) return t("lib.media.unsupportedAttachmentType");
  if (files.some((file) => file.size === 0 || file.size > MEDIA_LIMITS.attachmentBytes)) return t("lib.media.attachmentSize");
  if (files.reduce((sum, file) => sum + file.size, 0) > MEDIA_LIMITS.totalAttachmentBytes) return t("lib.media.totalAttachmentSize");
  return null;
}
