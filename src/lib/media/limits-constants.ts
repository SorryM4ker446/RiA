/**
 * Numeric upload/media limits.
 *
 * Kept dependency-free on purpose: `next.config.ts` imports MEDIA_LIMITS to size
 * the proxy body limit, and Next loads the config file outside its own module
 * resolver, so an `@/` alias import anywhere in this graph would fail to
 * resolve at build time. User-facing validation copy lives in `limits.ts`.
 *
 * The name is hyphenated rather than `limits.constants.ts` because the server
 * test loader infers "already has an extension" from `path.extname`, so a
 * second dot makes it skip the implicit `.ts` resolution.
 */
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
