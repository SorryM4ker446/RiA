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
  if (files.length > MEDIA_LIMITS.attachmentCount) return "每条消息最多添加 4 个图片附件。";
  if (files.some((file) => !(IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type))) return "仅支持 PNG、JPEG、WebP 和 GIF 图片。";
  if (files.some((file) => file.size === 0 || file.size > MEDIA_LIMITS.attachmentBytes)) return "每个附件须大于 0 字节且不超过 8 MiB。";
  if (files.reduce((sum, file) => sum + file.size, 0) > MEDIA_LIMITS.totalAttachmentBytes) return "附件总大小不能超过 20 MiB。";
  return null;
}
