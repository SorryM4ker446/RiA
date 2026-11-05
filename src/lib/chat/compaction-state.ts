import type { ModelMessage } from "ai";
import { z } from "zod";

/**
 * What goes with a conversation's summary besides its text: the tool calls it stands in
 * for in messages the summary does not otherwise cover, what the model was working with,
 * and an exact record of what was done, which no model wrote and so none can lose.
 */
const summaryStateSchema = z.object({
  calls: z.array(z.string()).default([]),
  files: z.array(z.object({ grantId: z.string(), path: z.string(), hash: z.string().optional() })).default([]),
  skills: z.array(z.string()).default([]),
  log: z.array(z.string()).default([]),
  /**
   * The files and skills put back under this summary, as they were when it was written.
   * Absent until the first request after it; sent unchanged from then on, so a provider's
   * prompt cache keeps matching it. A later change to a file is reported separately.
   */
  restored: z.string().optional(),
});
export type SummaryState = z.infer<typeof summaryStateSchema>;
export const EMPTY_SUMMARY_STATE: SummaryState = { calls: [], files: [], skills: [], log: [] };

/** Bounds on what is remembered; older entries are the first to go. */
const MAX_CALLS = 1000, MAX_FILES = 20, MAX_SKILLS = 20, MAX_LOG = 40, LOG_LINE_CHARACTERS = 240;

export function readSummaryState(stored: string | null | undefined): SummaryState {
  if (!stored) return EMPTY_SUMMARY_STATE;
  try { return summaryStateSchema.parse(JSON.parse(stored)); } catch { return EMPTY_SUMMARY_STATE; }
}

type ToolCall = { toolName: string; input: unknown; output?: unknown };

/** The tool calls in model messages, in order, each with its result when it has one. */
export function toolCallsIn(messages: ModelMessage[]): ToolCall[] {
  const results = new Map<string, unknown>();
  for (const message of messages) if (typeof message.content !== "string") for (const part of message.content) {
    if (part.type === "tool-result" && (part.output.type === "json" || part.output.type === "text" || part.output.type === "error-text")) results.set(part.toolCallId, part.output.value);
  }
  return messages.flatMap(message => typeof message.content === "string" ? [] : message.content.flatMap(part =>
    part.type === "tool-call" ? [{ toolName: part.toolName, input: part.input, output: results.get(part.toolCallId) }] : []));
}

/** Newest last, each entry once. */
const latestFirstSeen = <T>(items: T[], key: (item: T) => string, limit: number) => {
  const seen = new Map<string, T>();
  for (const item of items) { seen.delete(key(item)); seen.set(key(item), item); }
  return [...seen.values()].slice(-limit);
};

/** What a call did, for those whose effects outlast the conversation. */
function logLine({ toolName, input, output }: ToolCall): string | null {
  const fields = (input ?? {}) as { path?: unknown; command?: unknown };
  const result = (output ?? {}) as { exitCode?: unknown; status?: unknown; created?: unknown; added?: unknown; removed?: unknown; path?: unknown };
  if (toolName === "runTerminalCommand" && typeof fields.command === "string") {
    const outcome = typeof result.exitCode === "number" ? `exit ${result.exitCode}` : typeof result.status === "string" ? result.status : "no result recorded";
    return `ran: ${fields.command} -> ${outcome}`.slice(0, LOG_LINE_CHARACTERS);
  }
  if (toolName === "editProjectFile" && typeof fields.path === "string") {
    if (output === undefined || typeof result.path !== "string") return `edit of ${fields.path} did not complete`.slice(0, LOG_LINE_CHARACTERS);
    return `${result.created ? "created" : "edited"}: ${fields.path} (+${String(result.added ?? 0)} -${String(result.removed ?? 0)})`.slice(0, LOG_LINE_CHARACTERS);
  }
  return null;
}

/** Adds what these calls worked with and did, and the calls now folded. What was put back goes, as it belonged to the summary before. */
export function foldIntoState(state: SummaryState, change: { calls?: string[]; toolCalls?: ToolCall[] }): SummaryState {
  const files: SummaryState["files"] = [], skills: string[] = [], log: string[] = [];
  for (const call of change.toolCalls ?? []) {
    const fields = (call.input ?? {}) as { grantId?: unknown; path?: unknown; packageId?: unknown };
    const hash = (call.output as { hash?: unknown } | undefined)?.hash;
    if ((call.toolName === "readProjectFile" || call.toolName === "editProjectFile") && typeof fields.grantId === "string" && typeof fields.path === "string") files.push({ grantId: fields.grantId, path: fields.path, ...(typeof hash === "string" ? { hash } : {}) });
    if (call.toolName === "readPluginSkill" && typeof fields.packageId === "string") skills.push(fields.packageId);
    const line = logLine(call);
    if (line) log.push(line);
  }
  return {
    calls: [...new Set([...state.calls, ...(change.calls ?? [])])].slice(-MAX_CALLS),
    files: latestFirstSeen([...state.files, ...files], file => `${file.grantId}\n${file.path}`, MAX_FILES),
    skills: latestFirstSeen([...state.skills, ...skills], skill => skill, MAX_SKILLS),
    log: [...state.log, ...log].slice(-MAX_LOG),
  };
}

/** The exact record that travels under a summary. */
export function recordedFacts(state: Pick<SummaryState, "log">): string {
  return state.log.length ? `Recorded by the application as it happened, not written by a model:\n${state.log.map(line => `- ${line}`).join("\n")}` : "";
}
