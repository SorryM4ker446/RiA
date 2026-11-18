import { bindTerminalApproval, checkTerminalCommand, runTerminalCommand, stopTerminalCommand, terminalGrant, type TerminalCommandUpdate } from "@/lib/terminal/runtime";
import { z } from "zod";
import { approvalGate } from "./approval";
import { terminalInputSchema, type TerminalInput, type TerminalCommandResult } from "@/lib/terminal/schema";
import type { ToolDescriptor } from "./types";
import { readTerminalLog, readTerminalLogInputSchema, type ReadTerminalLogInput } from "@/lib/terminal/logs";
import { jsonSchema, zodSchema } from "ai";

const modelInput = terminalInputSchema.omit({ binding: true, autoReview: true });

export const terminalTool: ToolDescriptor<TerminalInput, TerminalCommandResult> = {
  id: "runTerminalCommand",
  displayName: "执行终端命令",
  description: "在你授权的文件夹里跑命令，构建、测试都能做。",
  modelDescription: "Use installed executables discovered through inherited PATH/PATHEXT and development-tool environment variables, including Python, Go and Node.js. Discover commands with Get-Command or where.exe; do not assume a runtime is installed or install it without a user request. The folder is the working directory for project tasks. Run a non-interactive Windows PowerShell command for requested local file or development work. Within the workspace folder you can list and search files, read source code and documents, create folders and files of any format, edit or overwrite existing files, copy, move, rename and delete, and run development commands. To read or change text files, prefer readProjectFile and editProjectFile when they are available: they work on exact text without PowerShell quoting or encoding problems. Use PowerShell to run, build and test, and to search, copy, move, rename or delete files. Use explicit paths and preserve unrelated files. No extra folder permission is needed for each operation; the conversation's approval rule, stated with the workspace, decides approval. Under ask and acceptEdits each call requires user approval of the exact command and working directory; under auto, a command that plainly serves the user's request runs without asking and others wait for approval; under full, commands execute without per-call approval. Only use the grantId of the conversation workspace listed below; it is the one folder the user chose for this conversation, and other granted folders are not available here. The working directory is not a sandbox: commands run as the Windows user. Do not use for ordinary questions, guess folder IDs, request credentials, or put secrets in commands/output. Return the actual result; never claim execution before the tool returns a result. No persistent shell, stdin, interactive prompts or elevated permissions. A call waits until its command exits, unless runInBackground is set: run servers, watchers and long builds you want to work beside in the background, then follow them with checkTerminalCommand and end them with stopTerminalCommand; never start one in the foreground, where the call cannot end. Without timeoutSeconds a command in a conversation runs until it exits or the user stops it, and one in a scheduled task is stopped after an hour; status timed-out means it was stopped at its limit, with the output so far. Any number of commands can run at once, so independent long commands need not wait for each other. Remaining ordinary child processes are stopped when the shell ends.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: "selectable" },
  ...approvalGate("command"),
  inputSchema: terminalInputSchema,
  modelInputSchema: jsonSchema<TerminalInput>(() => zodSchema(modelInput).jsonSchema, { validate: async value => {
    // The SDK also validates a resumed approval here, including its server
    // binding. Preserve that binding while checking the current permission.
    const parsed = terminalInputSchema.safeParse(value);
    // Bind before the SDK emits input-available, so the preview and saved
    // approval contain the same directory, permission revision and session ID.
    return parsed.success ? { success: true, value: await bindTerminalApproval(parsed.data) } : { success: false, error: parsed.error };
  } }),
  bindForApproval: bindTerminalApproval,
  reviewAction: input => ({ kind: "command", command: input.command, cwd: input.binding?.cwd ?? "", ...(input.runInBackground ? { runInBackground: true } : {}) }),
  execute: async ({ input, signal, runId, unattended, chatId }) => {
    const { command: _command, ...result } = await runTerminalCommand(input, signal, runId, { unattended, chatId });
    return result;
  },
};

export const readTerminalLogTool: ToolDescriptor<ReadTerminalLogInput, Awaited<ReturnType<typeof readTerminalLog>>> = {
  id: "readTerminalLog",
  displayName: "读取终端日志",
  description: "命令输出太长时，回头翻完整日志。",
  modelDescription: "Read the complete saved output of an earlier runTerminalCommand call whose result includes a `log` reference, because its in-memory capture kept only the beginning and end. Give logId from that reference. Read a page of lines from startLine, or pass search to list matching line numbers first and then read around them; continue at nextLine until it is null. `complete: false` means some output was not saved or the command did not finish. This only reads saved output: it does not run commands, and it fails if the folder's permission was withdrawn or the log expired.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: { follows: "runTerminalCommand" } },
  inputSchema: readTerminalLogInputSchema,
  execute: async ({ input, signal }) => readTerminalLog(input, terminalGrant, signal),
};

const commandIdSchema = z.uuid().describe("The command's id: the id field of runTerminalCommand's result, as listed in the request context for background commands.");

export const checkTerminalCommandInputSchema = z.strictObject({
  id: commandIdSchema,
  waitSeconds: z.number().int().min(0).max(600).optional()
    .describe("Optional. Wait up to this many seconds for the command to end before answering, instead of checking repeatedly. It answers as soon as the command ends."),
});
export type CheckTerminalCommandInput = z.infer<typeof checkTerminalCommandInputSchema>;

export const checkTerminalCommandTool: ToolDescriptor<CheckTerminalCommandInput, TerminalCommandUpdate> = {
  id: "checkTerminalCommand",
  displayName: "查看终端命令",
  description: "查看后台命令的新输出和状态。",
  modelDescription: "Check a terminal command of this conversation, usually one started with runInBackground: its status (running, completed, failed, stopped, timed-out), exit code, and only the output printed since the last check (newStdout, newStderr; omittedBytes counts output dropped between checks, which readTerminalLog can read when the result has a log reference). Pass waitSeconds to wait for it to end, for example a build or test run you need the result of. This only reads; it never runs or stops anything.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: { follows: "runTerminalCommand" } },
  inputSchema: checkTerminalCommandInputSchema,
  execute: async ({ input, signal, chatId }) => checkTerminalCommand(input.id, chatId, input.waitSeconds ?? 0, signal),
};

export const stopTerminalCommandInputSchema = z.strictObject({ id: commandIdSchema });
export type StopTerminalCommandInput = z.infer<typeof stopTerminalCommandInputSchema>;

export const stopTerminalCommandTool: ToolDescriptor<StopTerminalCommandInput, TerminalCommandUpdate> = {
  id: "stopTerminalCommand",
  displayName: "停止终端命令",
  description: "停止这个会话里还在运行的命令。",
  modelDescription: "Stop a terminal command of this conversation that is still running, such as a background server or watcher you no longer need, together with its child processes. Returns how it ended and the output printed since the last check. Stopping a command that already ended changes nothing.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: { follows: "runTerminalCommand" } },
  inputSchema: stopTerminalCommandInputSchema,
  execute: async ({ input, signal, chatId }) => stopTerminalCommand(input.id, chatId, signal),
};
