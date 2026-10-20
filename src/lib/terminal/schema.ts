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
  timeoutSeconds: z.number().int().min(1).max(600).default(120).describe("Execution deadline, including shell startup; at most 600 seconds."),
  binding: terminalBindingSchema.optional(),
});
export type TerminalInput = z.infer<typeof terminalInputSchema>;
export type TerminalSessionView = {
  id: string; grantId: string; command: string; cwd: string; shell: string;
  status: "running" | "completed" | "failed" | "stopped" | "timed-out";
  stdout: string; stderr: string; exitCode: number | null; truncated: boolean;
  startedAt: string; finishedAt: string | null;
};
export const terminalRuntimeAllowed = () => ["desktop", "test"].includes(process.env.APP_RUNTIME ?? "") && (process.platform === "win32" || process.env.APP_RUNTIME === "test");
