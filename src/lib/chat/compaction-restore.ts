import { estimateTextTokens } from "@/lib/models/context-budget";
import { activeSkillPackages } from "@/lib/plugins/store";
import { projectFileModifiedAt, readProjectFile } from "@/lib/project-files/service";
import type { SummaryState } from "./compaction-state";

/** What is put back after a fold, the way Claude Code bounds its own. */
const MAX_FILES = 5, FILE_TOKENS = 5_000, SKILL_TOKENS = 5_000, SKILLS_TOKENS = 25_000;
/** Most of the input budget it may use, so on a small window it leaves room to work in. */
export const RESTORED_SHARE = 0.15;
/** Files checked for changes on each request, the most recently used first. */
const MAX_CHECKED_FILES = 20;

/** The start of the text, cut to fit; a skill's opening instructions matter most. */
function fitted(text: string, tokens: number) {
  const size = estimateTextTokens(text);
  return size <= tokens ? text : `${text.slice(0, Math.floor(text.length * tokens / size))}\n… [cut to fit]`;
}

type RestoredFile = SummaryState["files"][number];

/** Most recently modified first; among files changed at the same moment, the last one used. */
async function mostRecentlyModified(files: RestoredFile[], signal?: AbortSignal) {
  const dated = await Promise.all(files.map(async (file, order) => {
    const modifiedAt = await projectFileModifiedAt(file, signal).catch(() => null);
    return modifiedAt === null ? null : { file, order, modifiedAt };
  }));
  signal?.throwIfAborted();
  return dated.filter(item => item !== null).sort((a, b) => b.modifiedAt - a.modifiedAt || b.order - a.order).slice(0, MAX_FILES).map(item => item.file);
}

async function fileLines(files: RestoredFile[], room: { tokens: number }, seen: RestoredFile[], signal?: AbortSignal) {
  const lines: string[] = [];
  for (const file of await mostRecentlyModified(files, signal)) {
    try {
      const read = await readProjectFile({ grantId: file.grantId, path: file.path, startLine: 1, lineCount: 2000 }, signal);
      const content = read.lines.map(line => line.text).join("\n");
      const size = estimateTextTokens(content);
      if (read.nextLine === null && size <= Math.min(FILE_TOKENS, room.tokens)) {
        room.tokens -= size;
        seen.push({ ...file, hash: read.hash });
        lines.push(`File ${file.path} as it was when this summary was written:\n${content}`);
      } else lines.push(`Referenced file: ${file.path} (too large to include; read it again if needed)`);
    } catch (error) {
      signal?.throwIfAborted();
      // Moved, deleted, or the folder's access was withdrawn: nothing to put back.
      void error;
    }
  }
  return lines;
}

async function skillLines(packageIds: string[], room: { tokens: number }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const active = await activeSkillPackages();
  const lines: string[] = [];
  let total = SKILLS_TOKENS;
  // The most recently used come first, so the oldest are the ones left out.
  for (const packageId of [...packageIds].reverse()) {
    const skill = active.find(item => item.row.packageId === packageId);
    const limit = Math.min(SKILL_TOKENS, total, room.tokens);
    if (!skill || limit <= 0) continue;
    const body = fitted(skill.manifest.skills.map(item => `${item.name}\n${item.instructions}`).join("\n\n"), limit);
    total -= estimateTextTokens(body); room.tokens -= estimateTextTokens(body);
    lines.push(`Skill ${packageId}, used earlier in this conversation:\n${body}`);
  }
  return lines;
}

/**
 * Files and skills the model was working with before the summary, read once when it is
 * written and sent unchanged after that. A file still in the conversation is not repeated.
 * Also says which files it saw as they are now, which a later change is measured against.
 */
export async function restoredContext(params: { state: SummaryState; inUse: Set<string>; workspaceId: string | null; allowFiles: boolean; allowSkills: boolean; inputTokens: number; signal?: AbortSignal }) {
  const room = { tokens: Math.floor(params.inputTokens * RESTORED_SHARE) };
  const seen: RestoredFile[] = [];
  const files = params.allowFiles ? params.state.files.filter(file => file.grantId === params.workspaceId && !params.inUse.has(file.path)) : [];
  const fileText = files.length ? await fileLines(files, room, seen, params.signal) : [];
  const skillText = params.allowSkills && params.state.skills.length ? await skillLines(params.state.skills, room, params.signal) : [];
  const lines = [...fileText, ...skillText];
  return { text: lines.length ? `Files and skills in use before the summary of earlier conversation:\n\n${lines.join("\n\n")}` : "", seen };
}

/**
 * Files the model saw that are no longer as it saw them, because something other than
 * its own edit changed them. Checking is a help: a file that cannot be read says nothing.
 */
export async function changedFiles(params: { seen: ReadonlyMap<string, string>; grantId: string; signal?: AbortSignal }) {
  const checked = [...params.seen].slice(-MAX_CHECKED_FILES);
  const changes = await Promise.all(checked.map(async ([path, hash]) => {
    try {
      const read = await readProjectFile({ grantId: params.grantId, path, startLine: 1, lineCount: 1 }, params.signal);
      return read.hash === hash ? null : `${path} (changed)`;
    } catch (error) {
      params.signal?.throwIfAborted();
      return (error as { reason?: unknown } | null)?.reason === "not-found" ? `${path} (no longer exists)` : null;
    }
  }));
  params.signal?.throwIfAborted();
  const lines = changes.filter(item => item !== null);
  return lines.length ? `Files that changed since you last saw them in this conversation; read one again before relying on what you saw:\n${lines.join("\n")}` : "";
}
