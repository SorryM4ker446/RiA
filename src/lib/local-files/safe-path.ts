import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_FILE_LIMITS,
  LocalFileRefused,
  READABLE_EXTENSIONS,
  WRITABLE_EXTENSIONS
} from "@/lib/local-files/limits";

/*
 * Path handling for user-granted directories.
 *
 * The rule this module exists to enforce is narrow and absolute: a path the
 * assistant supplies never decides what is opened. The user grants a root, the
 * root is resolved to its real location once, and every later operation is
 * decided by comparing a freshly resolved real path against that root. A name
 * can only ever select something already inside the grant.
 *
 * Two details are deliberate and worth keeping:
 *
 * - Real paths, not lexical ones. `path.join(root, "..")` looks like a path
 *   under the root and is not one. Junctions and symlinks do the same thing
 *   without any `..` at all, so containment is decided on `realpath` output.
 * - `node:fs/promises`, like every other module that touches disk here. The
 *   synchronous `fs` functions are statically analysed by the bundler's file
 *   tracer, and a filesystem call whose argument cannot be resolved at build
 *   time makes it give up and copy the whole repository into the desktop
 *   runtime. That is a size and privacy problem, and `prepare-desktop` refuses
 *   to build when it happens.
 */

/** A grant the user gave, already resolved. */
export type ResolvedGrant = {
  label: string;
  /** The path the user chose, for display. */
  path: string;
  /** The real path containment is decided against. */
  realPath: string;
  /**
   * Whether the grant is one file rather than a directory, so granting a single
   * sensitive file stays possible without granting everything beside it.
   */
  isFile: boolean;
};

/** A path that has been resolved and proven to sit inside a grant. */
export type GrantedTarget = {
  /** Absolute, resolved, inside the grant. Safe to hand to `fs`. */
  absolutePath: string;
  /** Path relative to the grant root, using forward slashes. What the model sees. */
  relativePath: string;
  byteSize: number;
  isFile: boolean;
  isDirectory: boolean;
};

/**
 * The real location of a path.
 *
 * Junctions and symlinks are resolved by the operating system here, which is
 * what makes containment meaningful; the directory-grant tests fail if this
 * ever stops resolving them, so the guarantee is checked rather than assumed.
 */
export async function realPathOf(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    throw new LocalFileRefused("not-found", "The path could not be resolved.");
  }
}

/**
 * True for a UNC path or any other location on a network.
 *
 * Granting a network location would let content leave the machine through a
 * share the assistant did not have to be given, so the first version refuses
 * them outright rather than asking the user to confirm.
 */
export function isNetworkLocation(candidate: string): boolean {
  return candidate.startsWith("\\\\") || candidate.startsWith("//");
}

/**
 * Locations refused in their entirety.
 *
 * Matched exactly rather than as a prefix, so refusing the user profile does
 * not also refuse `Documents` inside it. A profile root is too broad to grant
 * by accident, but a notes folder within it is ordinary material.
 */
function blockedExactLocations(): string[] {
  return [
    os.homedir(),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    process.env.APPDATA,
    process.env.LOCALAPPDATA
  ].filter((root): root is string => Boolean(root));
}

/**
 * Locations refused including everything beneath them.
 *
 * The operating system's own directories and the places credentials are kept.
 * Browser profiles are here because they hold cookies and saved passwords for
 * every other site, not just for the assistant.
 */
function blockedSubtrees(): string[] {
  const profile = os.homedir();
  const roots = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData].filter(
    (root): root is string => Boolean(root)
  );
  const underProfile = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    "AppData/Local/Google/Chrome/User Data",
    "AppData/Local/Microsoft/Edge/User Data",
    "AppData/Roaming/Mozilla/Firefox/Profiles"
  ].map((relative) => path.resolve(profile, relative));
  return [...roots, ...underProfile];
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

/**
 * Whether a path is somewhere this application refuses to read.
 *
 * Compared on resolved paths so a link pointing at `C:\Windows` is caught as
 * `C:\Windows` rather than as whatever the link was called.
 */
export function isBlockedLocation(realPath: string): boolean {
  if (blockedExactLocations().some((blocked) => samePath(realPath, blocked))) return true;
  return blockedSubtrees().some((blocked) => isSameOrInside(realPath, blocked));
}

/**
 * Whether `candidate` is `root` itself or something beneath it.
 *
 * `path.relative` is used rather than string prefixing because a prefix check
 * accepts `/data-secret` for a root of `/data`, and because on Windows it
 * compares case-insensitively, which the filesystem does.
 */
export function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function extensionOf(name: string): string {
  return path.extname(name).toLowerCase();
}

/**
 * Reject a name the assistant supplied before it is ever joined to anything.
 *
 * Separated from resolution so a traversal is refused on its own terms instead
 * of being reported as an escape, which would be misleading about what
 * happened.
 */
function assertRelativeName(relative: string): string {
  const trimmed = relative.trim().replace(/\\/g, "/");
  if (isNetworkLocation(trimmed)) {
    throw new LocalFileRefused("network-location", "Network locations are not available.");
  }
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw new LocalFileRefused("traversal", "Only names inside the granted directory are accepted.");
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new LocalFileRefused("traversal", "A name inside the granted directory is required.");
  }
  for (const segment of segments) {
    // Checked before the hidden-name rule below, because `..` is a climb out of
    // the grant and reporting it as "hidden" would describe the wrong thing.
    if (segment === "." || segment === "..") {
      throw new LocalFileRefused("traversal", "Only names inside the granted directory are accepted.");
    }
    // A leading dot is how credential material is spelled on every platform this
    // targets (`.env`, `.ssh`, `.git`, `.npmrc`), so it is refused as a
    // category rather than per extension.
    if (segment.startsWith(".")) {
      throw new LocalFileRefused("hidden", "Hidden files and folders are not available.");
    }
    if (segment.length > LOCAL_FILE_LIMITS.nameLength) {
      throw new LocalFileRefused("name-too-long", "The name is too long.");
    }
  }
  return segments.join("/");
}

/**
 * Turn a grant the user gave into the one form that is safe to compare against.
 *
 * Called when the grant is created. The directory can be renamed, moved, or
 * replaced between that moment and its first use, which is why the stored real
 * path — not a freshly resolved one — is the boundary every later check uses.
 */
export async function resolveGrant(input: { label: string; path: string }): Promise<ResolvedGrant> {
  const chosen = input.path.trim();
  if (!chosen) {
    throw new LocalFileRefused("not-found", "A directory is required.");
  }
  if (isNetworkLocation(chosen)) {
    throw new LocalFileRefused("network-location", "Network locations are not available.");
  }

  const realPath = await realPathOf(chosen);
  if (isBlockedLocation(realPath)) {
    throw new LocalFileRefused("blocked-location", "This location is not available.");
  }

  const stats = await lstat(realPath);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new LocalFileRefused("not-found", "Only a file or a folder can be granted.");
  }
  // A drive root is never what was meant, and one confirmation should not be
  // able to open an entire volume by pointing at it.
  if (stats.isDirectory() && path.dirname(realPath) === realPath) {
    throw new LocalFileRefused("blocked-location", "This location is not available.");
  }

  return { label: input.label.trim() || path.basename(realPath) || realPath, path: chosen, realPath, isFile: stats.isFile() };
}

/**
 * Resolve a name the assistant supplied to a real path inside the grant.
 *
 * Containment is decided against `grant.realPath` — the path as it was when the
 * user granted it — and never against a freshly resolved root. Re-resolving the
 * root would look more careful and be less safe: replacing the granted folder
 * with a junction would move the boundary along with it, and the boundary would
 * follow the swap instead of refusing it. What is re-resolved every time is the
 * *target*, which is what a junction inside the grant can influence.
 *
 * `mode` is what the caller intends to do, and it is enforced here rather than
 * at the call site: a format the assistant may read is not always one it may
 * write, and a file that does not exist yet is the ordinary case for a write
 * rather than a missing-file error.
 */
export async function resolveWithinGrant(
  grant: { realPath: string },
  relative: string,
  mode: "read" | "write" | "list"
): Promise<GrantedTarget> {
  const root = grant.realPath;
  if (isBlockedLocation(root)) {
    throw new LocalFileRefused("blocked-location", "This location is not available.");
  }

  // Listing the grant itself is addressed by the empty name; every other
  // operation has to name something inside it.
  if (mode === "list" && (relative.trim() === "" || relative.trim() === ".")) {
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new LocalFileRefused("not-a-directory", "Only a folder can be listed.");
    }
    return { absolutePath: root, relativePath: "", byteSize: 0, isFile: false, isDirectory: true };
  }

  const name = assertRelativeName(relative);
  const extension = extensionOf(name);
  if (mode === "read" && !(READABLE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new LocalFileRefused("unsupported-format", "This file type cannot be read.");
  }
  if (mode === "write" && !(WRITABLE_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new LocalFileRefused("unsupported-format", "Only Markdown and plain text files can be created.");
  }

  const candidate = path.resolve(root, ...name.split("/"));
  // The parent always has to exist and resolve inside the grant. The file
  // itself may not, which is the ordinary case for something being created.
  const realParent = await realPathOf(path.dirname(candidate));
  if (!isSameOrInside(realParent, root)) {
    throw new LocalFileRefused("symlink-escape", "That name does not resolve inside the granted directory.");
  }
  if (isBlockedLocation(realParent)) {
    throw new LocalFileRefused("blocked-location", "This location is not available.");
  }

  const target = path.join(realParent, path.basename(candidate));
  const stats = await stat(target).catch(() => null);
  // A file that is itself a link is resolved too, so a link dropped inside the
  // grant cannot be used to read what it points at.
  const absolutePath = stats ? await realPathOf(target) : target;
  if (!isSameOrInside(absolutePath, root)) {
    throw new LocalFileRefused("symlink-escape", "That name does not resolve inside the granted directory.");
  }

  if (mode === "list") {
    if (!stats?.isDirectory()) throw new LocalFileRefused("not-a-directory", "Only a folder can be listed.");
  } else if (mode === "read") {
    if (!stats) throw new LocalFileRefused("not-found", "That file does not exist.");
    if (!stats.isFile()) throw new LocalFileRefused("not-a-file", "Only a file can be used here.");
    if (stats.size > LOCAL_FILE_LIMITS.fileBytes) {
      throw new LocalFileRefused("too-large", "This file is larger than the limit for a single read.");
    }
  } else if (stats && !stats.isFile()) {
    throw new LocalFileRefused("not-a-file", "A new file cannot be created over a folder.");
  }

  return {
    absolutePath,
    relativePath: path.relative(root, absolutePath).split(path.sep).join("/") || path.basename(absolutePath),
    byteSize: stats?.size ?? 0,
    isFile: stats?.isFile() ?? true,
    isDirectory: stats?.isDirectory() ?? false
  };
}
