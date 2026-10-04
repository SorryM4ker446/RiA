import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raises the patch version before a build.
 *
 * Squirrel identifies an installation by its version, and the installer it
 * writes is named after it. Repackaging without moving that number forward
 * produces a second `0.1.0 Setup.exe` beside the first: Windows offers to run
 * the same version again, the RELEASES file gains a duplicate entry, and an
 * update published from it is not newer than what is already installed. The
 * number is the one thing that makes a new installer distinguishable, so it is
 * raised here rather than left to be remembered.
 *
 * `package.json` is the only place the version lives — the main process and the
 * desktop runtime both read it — so one write here reaches every consumer.
 *
 * The increment is the patch level and nothing else. A major or minor bump is a
 * decision about what changed, and a script that made that decision would make
 * it without anyone choosing it.
 *
 * Only the version line is rewritten. Reparsing the manifest and printing it
 * back would drop the CRLF endings this file uses, which turns a one-line
 * change into a whole-file diff and hides the actual change in review.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(repositoryRoot, "package.json");
const source = readFileSync(packageJsonPath, "utf8");

const versionLine = /^(\s*"version"\s*:\s*")([^"]+)(".*)$/m;
const match = versionLine.exec(source);
if (!match) {
  console.error("无法递增版本号: package.json 中没有找到 version 字段。");
  process.exit(1);
}
const [, prefix, current, suffix] = match;
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!parsed) {
  console.error(`无法递增版本号: ${current} 不是 major.minor.patch 形式。`);
  process.exit(1);
}
const next = `${parsed[1]}.${parsed[2]}.${Number(parsed[3]) + 1}`;
writeFileSync(packageJsonPath, source.replace(versionLine, `${prefix}${next}${suffix}`));
console.log(`版本号: ${current} → ${next}`);