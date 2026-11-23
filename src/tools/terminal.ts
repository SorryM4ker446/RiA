import { bindTerminalApproval, checkTerminalCommand, runTerminalCommand, stopTerminalCommand, terminalGrant, type TerminalCommandUpdate } from "@/lib/terminal/runtime";
import { terminalResultForModel } from "@/lib/terminal/model-output";
import { z } from "zod";
import { approvalGate } from "./approval";
import { terminalInputSchema, type TerminalInput, type TerminalCommandResult } from "@/lib/terminal/schema";
import type { ToolDescriptor } from "./types";
import { readTerminalLog, readTerminalLogInputSchema, type ReadTerminalLogInput } from "@/lib/terminal/logs";
import { jsonSchema, zodSchema } from "ai";

const modelInput = terminalInputSchema.omit({ binding: true, autoReview: true });
export const terminalModelOutput = ({ output }: { output: unknown }) => ({ type: "json" as const, value: terminalResultForModel(output) as never });

export const terminalTool: ToolDescriptor<TerminalInput, TerminalCommandResult> = {
  id: "runTerminalCommand",
  displayName: "执行终端命令",
  description: "在你授权的文件夹里跑命令，构建、测试都能做。",
  modelDescription: "Run one non-interactive Windows PowerShell command in the conversation's workspace folder. It runs as the Windows user: the folder is not a sandbox. Whether to use it is your judgement; the test is whether the user's request needs something done on their computer that your other tools do not cover: running, building or testing code, searching across files, copying, moving, renaming or deleting, or using an installed program. Use it for: \"run the tests and fix what fails\" (run, then read the output); \"which files mention API_KEY?\" (a search across the folder); \"start the dev server so I can try it\" (in the background, since it does not end). Skip it for: reading or changing a text file when readProjectFile and editProjectFile are available (they work on exact text, without quoting or encoding problems); ordinary questions; installing a runtime the user did not ask for. Within the folder you can list and search files, read source code and documents, create folders and files of any format, edit or overwrite existing files, copy, move, rename and delete, and run development commands; use explicit paths and preserve unrelated files. Installed executables are found through the inherited PATH/PATHEXT and development-tool variables (Python, Go, Node.js and others): find one with Get-Command or where.exe rather than assuming it is installed. Only use the grantId of the conversation workspace listed below: it is the one folder the user chose for this conversation, other granted folders are not available here, and none may be guessed. No other permission is needed for each operation; the conversation's approval rule, stated with the workspace, decides approval: under ask and acceptEdits each call waits for the user to approve the exact command and working directory; under auto, a command that plainly serves the user's request runs without asking and others wait; under full, commands run without per-call approval. There is no persistent shell, stdin, interactive prompt or elevated permission. Never request credentials or put secrets in commands or output. A call waits until its command exits, unless runInBackground is set: run servers, watchers and long builds you want to work beside in the background, follow them with checkTerminalCommand and end them with stopTerminalCommand; never start one in the foreground, where the call cannot end. Any number of commands can run at once, so independent long commands need not wait for each other. Without timeoutSeconds a command in a conversation runs until it exits or the user stops it, and one in a scheduled task is stopped after an hour; status timed-out means it was stopped at its limit, with the output so far. Remaining ordinary child processes are stopped when the shell ends. Long output is shown as its beginning and end, with how many bytes were left out between them; read the rest with readTerminalLog using the result's log reference, searching it for errors or failures before concluding they were not printed. Report the actual result, and never claim a command ran before the tool returns.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: "selectable" },
  ...approvalGate("command"),
  inputSchema: terminalInputSchema,
  modelInputSchema: jsonSchema<TerminalInput>(() => zodSchema(modelInput).jsonSchema, { validate: async value => {
    // The model boundary strips approval state from new calls. The SDK also
    // validates a resumed approval here, with its original server binding.
    const parsed = terminalInputSchema.safeParse(value);
    // Bind before the SDK emits input-available, so the preview and saved
    // approval contain the same directory, permission revision and session ID.
    return parsed.success ? { success: true, value: await bindTerminalApproval(parsed.data) } : { success: false, error: parsed.error };
  } }),
  bindForApproval: async input => { await bindTerminalApproval(input); },
  // Long output reaches the model as its beginning and end, with the log to read the rest.
  modelOutput: async output => terminalModelOutput({ output }),
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
  modelDescription: "Check a terminal command of this conversation, usually one started with runInBackground. Use it to follow a background command, or pass waitSeconds to wait for one to end when you need its result, such as a build or a test run. Returns its status (running, completed, failed, stopped, timed-out), exit code, and only the output printed since the last check (newStdout, newStderr; omittedBytes counts output dropped between checks, which readTerminalLog can read when the result has a log reference). This only reads; it never runs or stops anything.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: { follows: "runTerminalCommand" } },
  inputSchema: checkTerminalCommandInputSchema,
  modelOutput: async output => terminalModelOutput({ output }),
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
  modelOutput: async output => terminalModelOutput({ output }),
  execute: async ({ input, signal, chatId }) => stopTerminalCommand(input.id, chatId, signal),
};
