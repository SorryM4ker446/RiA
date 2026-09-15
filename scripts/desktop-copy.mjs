import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Copies the Next.js standalone output into the desktop runtime.
 *
 * The standalone output links externally traced packages instead of copying
 * them. Node's own recursive copy recreates those links verbatim, which fails
 * on Windows without Developer Mode, so each link is resolved and recreated as
 * a junction. The runtime therefore works on a normal developer account.
 */
export function copyStandaloneDirectory(source, target, options = {}) {
  const { filter = () => true } = options;
  mkdirSync(target, { recursive: true });

  const pending = [{ source, target }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current.source, { withFileTypes: true })) {
      const entrySource = join(current.source, entry.name);
      const entryTarget = join(current.target, entry.name);
      if (!filter(entrySource, entry)) continue;

      const stats = lstatSync(entrySource);
      if (stats.isSymbolicLink()) {
        const linkTarget = readlinkSync(entrySource);
        const absoluteTarget = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(entrySource), linkTarget);
        mkdirSync(dirname(entryTarget), { recursive: true });
        try {
          symlinkSync(absoluteTarget, entryTarget, "junction");
        } catch {
          // Fall back to the linked content when the platform refuses the link.
          cpSync(absoluteTarget, entryTarget, { recursive: true });
        }
        continue;
      }
      if (stats.isDirectory()) {
        pending.push({ source: entrySource, target: entryTarget });
        continue;
      }
      mkdirSync(dirname(entryTarget), { recursive: true });
      cpSync(entrySource, entryTarget);
    }
  }
}
