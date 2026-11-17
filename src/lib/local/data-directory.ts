import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "@/lib/server/api-error";

/** The folder holding the local SQLite database; application-owned files live beside it. */
export function localDataDirectory(purpose: string): string {
  const url = process.env.DATABASE_URL || "";
  const databaseFile = url.startsWith("file://") ? fileURLToPath(url) : url.startsWith("file:") ? url.slice(5) : "";
  if (!isAbsolute(databaseFile)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${purpose} requires an absolute local SQLite path` });
  return dirname(databaseFile);
}

/**
 * The folder for application-owned files that can be lost without losing
 * workspace content (undo copies, terminal output). The desktop app passes the
 * cache folder the person chose; otherwise it is the data folder itself.
 */
export function localCacheDirectory(purpose: string): string {
  const configured = process.env.RIA_CACHE_DIRECTORY?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${purpose} requires an absolute cache path` });
    return configured;
  }
  return localDataDirectory(purpose);
}
