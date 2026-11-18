/**
 * The largest backup archive RiA writes, imports or restores. Kept apart from the
 * archive schema so the settings page can check a file before uploading it. With
 * document vectors in the archive, a large knowledge base alone can take a few
 * gigabytes.
 */
export const BACKUP_MAX_BYTES = 4 * 1024 * 1024 * 1024;
