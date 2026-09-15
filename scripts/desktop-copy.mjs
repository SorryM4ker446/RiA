import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Copies the Next.js standalone output into the desktop runtime.
 *
 * The standalone output links externally traced packages instead of copying
 * them. Resolve those links while preparing the runtime so the generated
 * desktop bundle contains ordinary files and directories. This avoids making
 * Electron Forge create symlinks during packaging on Windows.
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
        const targetStats = lstatSync(absoluteTarget);
        if (targetStats.isDirectory()) {
          copyStandaloneDirectory(absoluteTarget, entryTarget, options);
        } else {
          mkdirSync(dirname(entryTarget), { recursive: true });
          cpSync(absoluteTarget, entryTarget);
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
