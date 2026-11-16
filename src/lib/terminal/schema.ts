import { z } from "zod";
import { autoReviewSchema } from "@/lib/approvals/auto-review-schema";

// outputBytes bounds the in-memory capture; tailBytes of it keep each stream's latest output.
// There is no cap on commands running at once: each conversation and task may
// run as many as its work needs. Only finished records are retained and pruned.
export const TERMINAL_LIMITS = { outputBytes: 64 * 1024, tailBytes: 8 * 1024, retainedSessions: 32, retentionMs: 30 * 60_000 } as const;
/**
 * The longest a command may be given, and what a command in a run nobody is
 * watching gets when it names no time of its own. In a conversation the person
 * can stop a command, so none is imposed there; a scheduled task has no one to
 * stop a server or a hung process, so it is stopped after an hour.
 */
export const TERMINAL_MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
export const TERMINAL_UNATTENDED_TIMEOUT_SECONDS = 60 * 60;
/** Where the complete output of a command that exceeded the capture was saved. */
export const terminalLogReferenceSchema = z.object({
  id: z.uuid(), stdoutBytes: z.number().int().nonnegative(), stderrBytes: z.number().int().nonnegative(),
  complete: z.boolean(), expiresAt: z.string(),
});
export type TerminalLogReference = z.infer<typeof terminalLogReferenceSchema>;
export const terminalBindingSchema = z.strictObject({
  sessionId: z.uuid(), grantId: z.string().min(1).max(200), revision: z.string().min(1), cwd: z.string().min(1).max(4000),
});
export const terminalInputSchema = z.strictObject({
  grantId: z.string().min(1).max(200).describe("grantId of the conversation's workspace folder."),
  command: z.string().trim().min(1).refine(value => !value.includes("\0"), "NUL is not allowed").describe("Complete Windows PowerShell command or script. Approval follows the conversation's approval rule. No interactive input is available."),
  timeoutSeconds: z.number().int().min(1).max(TERMINAL_MAX_TIMEOUT_SECONDS).optional()
    .describe("Optional. Stop the command after this many seconds and return what it printed so far with status timed-out. Set it for a command that may not exit on its own or may hang: a server, a watcher, a network call. Leave it out for builds and tests that end by themselves; in a conversation there is no limit, and a scheduled task stops a command after an hour."),
  runInBackground: z.boolean().optional()
    .describe("Optional. Start the command and return at once with its id while it keeps running: for a server, a watcher, or a long build or test run you want to keep working beside. Read what it printed with checkTerminalCommand (it can wait for the command to end), stop it with stopTerminalCommand; the next turn is told when it ends. Leave it out for commands whose result you need before going on."),
  binding: terminalBindingSchema.optional(),
  autoReview: autoReviewSchema.optional(),
});
export type TerminalInput = z.infer<typeof terminalInputSchema>;
const fileVersionSchema = z.object({ bytes: z.number().nonnegative(), lines: z.number().int().nonnegative().optional() });
export const terminalFileChangeSchema = z.object({
  path: z.string().min(1).max(4000),
  kind: z.enum(["created", "modified", "deleted"]),
  before: fileVersionSchema.nullable(), after: fileVersionSchema.nullable(),
});
export type TerminalFileChange = z.infer<typeof terminalFileChangeSchema>;
export const terminalFileChangesSchema = z.object({ files: z.array(terminalFileChangeSchema).max(100), complete: z.boolean() });
export type TerminalFileChanges = z.infer<typeof terminalFileChangesSchema>;
export type TerminalSessionView = {
  id: string; grantId: string; command: string; cwd: string; shell: string;
  status: "running" | "completed" | "failed" | "stopped" | "timed-out";
  stdout: string; stderr: string; exitCode: number | null; truncated: boolean;
  startedAt: string; finishedAt: string | null;
  fileChanges?: TerminalFileChanges;
  /** The time limit the command ran under, when it had one. */
  timeoutSeconds?: number;
  /** Started in the background: the call returned while the command kept running. */
  background?: true;
  /** Present when output exceeded the capture and a full log was kept. */
  log?: TerminalLogReference;
};
// The complete command belongs to the tool input and the live session view.
// Echoing it in each result duplicates large scripts throughout chat history.
export type TerminalCommandResult = Omit<TerminalSessionView, "command">;
export const terminalRuntimeAllowed = () => ["desktop", "test"].includes(process.env.APP_RUNTIME ?? "") && (process.platform === "win32" || process.env.APP_RUNTIME === "test");
