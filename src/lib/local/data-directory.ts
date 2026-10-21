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
