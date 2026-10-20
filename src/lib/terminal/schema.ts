import { z } from "zod";

export const TERMINAL_LIMITS = { outputBytes: 64 * 1024, concurrent: 2, retainedSessions: 24, retentionMs: 30 * 60_000 } as const;
export const terminalApprovalModeSchema = z.enum(["approval", "full-access"]);
export type TerminalApprovalMode = z.infer<typeof terminalApprovalModeSchema>;
export const terminalBindingSchema = z.strictObject({
  sessionId: z.uuid(), grantId: z.string().min(1).max(200), revision: z.string().min(1), cwd: z.string().min(1).max(4000),
});
export const terminalInputSchema = z.strictObject({
  grantId: z.string().min(1).max(200).describe("ID of a folder explicitly enabled for terminal commands."),
  command: z.string().trim().min(1).refine(value => !value.includes("\0"), "NUL is not allowed").describe("Complete Windows PowerShell command or script. Approval follows the folder's terminal approval mode. No interactive input is available."),
  // Accepted only to restore old approval payloads; no longer enforced.
  timeoutSeconds: z.number().int().min(1).optional(),
  binding: terminalBindingSchema.optional(),
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
};
// The complete command belongs to the tool input and the live session view.
// Echoing it in each result duplicates large scripts throughout chat history.
export type TerminalCommandResult = Omit<TerminalSessionView, "command">;
export const terminalRuntimeAllowed = () => ["desktop", "test"].includes(process.env.APP_RUNTIME ?? "") && (process.platform === "win32" || process.env.APP_RUNTIME === "test");
