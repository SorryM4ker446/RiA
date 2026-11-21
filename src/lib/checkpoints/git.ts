import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

/*
 * The workspace's own git repository as a source of earlier content: a file
 * whose bytes are exactly its blob in the index needs no copy of its own,
 * since git can give the same bytes back; and files git ignores are, apart
 * from small ones, build output or caches that can be made again.
 */

const run = promisify(execFile);
const gitEnvironment = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
/** Ignored files up to this size are still copied: a `.env` or local settings file is small and not made again. */
export const IGNORED_COPY_BYTES = 1024 * 1024;

export type GitView = { oids: Map<string, string>; ignoredFiles: Set<string>; ignoredDirectories: Set<string> };

const split = (output: string) => output.split("\0").filter(Boolean);

/** The index's blob for each tracked file and what git ignores, with paths relative to root; null outside a repository or when git is unavailable. */
export async function readGitView(root: string): Promise<GitView | null> {
  const options = { cwd: root, env: gitEnvironment(), windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024 * 1024 };
  try {
    // A failed Git read must still wait for its sibling to release the working directory.
    const [staged, ignored] = await Promise.allSettled([
      run("git", ["-c", "core.quotepath=off", "ls-files", "--stage", "-z"], options),
      run("git", ["-c", "core.quotepath=off", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], options),
    ]);
    if (staged.status !== "fulfilled" || ignored.status !== "fulfilled") return null;
    const oids = new Map<string, string>();
    for (const entry of split(staged.value.stdout)) {
      // "<mode> <oid> <stage>\t<path>"; only ordinary files at stage 0.
      const tab = entry.indexOf("\t");
      const [mode, oid, stage] = entry.slice(0, tab).split(" ");
      if (stage === "0" && (mode === "100644" || mode === "100755")) oids.set(entry.slice(tab + 1), oid);
    }
    const ignoredFiles = new Set<string>(), ignoredDirectories = new Set<string>();
    for (const entry of split(ignored.value.stdout)) (entry.endsWith("/") ? ignoredDirectories.add(entry.slice(0, -1)) : ignoredFiles.add(entry));
    return { oids, ignoredFiles, ignoredDirectories };
  } catch { return null; }
}

export function isIgnored(view: GitView, relative: string) {
  if (view.ignoredFiles.has(relative)) return true;
  for (let index = relative.indexOf("/"); index >= 0; index = relative.indexOf("/", index + 1)) {
    if (view.ignoredDirectories.has(relative.slice(0, index))) return true;
  }
  return false;
}

/** Hashes content the way git names a blob, with the algorithm the repository's ids use. */
export function gitBlobHasher(size: number, oidLength: number) {
  const hash = createHash(oidLength === 64 ? "sha256" : "sha1").update(`blob ${size}\0`);
  return { update: (bytes: Uint8Array) => hash.update(bytes), digest: () => hash.digest("hex") };
}

/**
 * Writes a blob from the repository to a new file at `temporary`, any size,
 * checking as it streams that it is the content expected (by SHA-256); false
 * when git no longer has it, it differs or it could not be written. Settles
 * only once git has exited and the file is closed: a failed write stops git,
 * and what was written is removed after both are done, so nothing still holds
 * the file when the caller moves on.
 */
export async function writeGitBlob(root: string, oid: string, expectedSha256: string, temporary: string): Promise<boolean> {
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(oid)) return false;
  const hash = createHash("sha256");
  let created = false;
  const written = await new Promise<boolean>(resolve => {
    const out = createWriteStream(temporary, { flags: "wx" });
    out.on("open", () => { created = true; });
    let child: ChildProcess;
    try {
      child = spawn("git", ["cat-file", "blob", oid], { cwd: root, env: gitEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      out.on("error", () => {});
      out.on("close", () => resolve(false));
      out.destroy();
      return;
    }
    let exited = false, outClosed = false, failed = false, exitCode: number | null = null;
    const settle = () => { if (exited && outClosed) resolve(!failed && exitCode === 0); };
    const fail = () => {
      if (failed) return;
      failed = true;
      if (!exited && child.pid) child.kill();
      out.destroy();
    };
    child.stdout!.on("data", (chunk: Buffer) => hash.update(chunk));
    child.stdout!.pipe(out);
    // Node emits close after an unsuccessful spawn too, once its stdio is closed.
    child.on("error", fail);
    child.stdout!.on("error", fail);
    child.on("close", code => { exited = true; exitCode = code; if (code !== 0) fail(); settle(); });
    out.on("error", fail);
    out.on("close", () => { outClosed = true; settle(); });
  });
  if (written && hash.digest("hex") === expectedSha256) return true;
  // Only a file this call created is removed: one already at that name is not ours.
  if (created) await rm(temporary, { force: true }).catch(() => {});
  return false;
}
