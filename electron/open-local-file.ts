import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** The service resolves grant containment; this bridge opens an existing file. */
export async function openLocalFile(target: unknown, openPath: (path: string) => Promise<string>): Promise<{ opened: boolean }> {
  if (typeof target !== "string" || !isAbsolute(target) || target.includes("\0")) return { opened: false };
  try {
    if (!(await stat(target)).isFile()) return { opened: false };
    return { opened: !(await openPath(target)) };
  } catch { return { opened: false }; }
}
