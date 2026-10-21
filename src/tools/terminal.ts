import { bindTerminalApproval, runTerminalCommand, terminalGrant } from "@/lib/terminal/runtime";
import { terminalInputSchema, type TerminalInput, type TerminalCommandResult } from "@/lib/terminal/schema";
import type { ToolDescriptor } from "./types";
import { readTerminalLog, readTerminalLogInputSchema, type ReadTerminalLogInput } from "@/lib/terminal/logs";
import { jsonSchema, zodSchema } from "ai";

const modelInput = terminalInputSchema.omit({ binding: true, timeoutSeconds: true });

export const terminalTool: ToolDescriptor<TerminalInput, TerminalCommandResult> = {
  id: "runTerminalCommand",
  displayName: "执行终端命令",
  description: "在授权目录使用 PowerShell 和已安装的开发工具完成任务，支持完全访问或逐条审批。",
  modelDescription: "Use installed executables discovered through inherited PATH/PATHEXT and development-tool environment variables, including Python, Go and Node.js. Discover commands with Get-Command or where.exe; do not assume a runtime is installed or install it without a user request. The folder is the working directory for project tasks. Run a non-interactive Windows PowerShell command for requested local file or development work. Within a terminal-enabled folder you can list and search files, read source code and documents, create folders and files of any format, edit or overwrite existing files, copy, move, rename and delete, and run development commands. To read or change text files, prefer readProjectFile and editProjectFile when they are available: they work on exact text without PowerShell quoting or encoding problems. Use PowerShell to run, build and test, and to search, copy, move, rename or delete files. Use explicit paths and preserve unrelated files. No extra folder permission is needed for each operation after terminal access is granted; the folder's terminalApprovalMode determines approval. In approval mode each tool call requires user approval of the exact command and working directory; in full-access mode commands execute automatically without per-call approval. Only use a grantId listed in the terminal-enabled folders below. The working directory is not a sandbox: commands run as the Windows user. Do not use for ordinary questions, guess folder IDs, request credentials, or put secrets in commands/output. Return the actual result; never claim execution before the tool returns a result. No persistent shell, stdin, interactive prompts or elevated permissions. Commands have no automatic execution timeout. The user can stop a running command; remaining ordinary child processes are stopped when the shell ends.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "执行终端命令", placeholder: "描述需要执行的操作", submitLabel: "发送", primaryFieldKey: "command", primaryFieldLabel: "PowerShell 命令", fields: [] },
  requiresApproval: async input => (await terminalGrant(terminalInputSchema.parse(input).grantId)).terminalApprovalMode !== "full-access",
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
  execute: async ({ input, signal, runId }) => {
    const { command: _command, ...result } = await runTerminalCommand(input, signal, runId);
    return result;
  },
  buildAssistantText: ({ output }) => [output.status, output.stdout, output.stderr, `Exit code: ${output.exitCode ?? "—"}`].filter(Boolean).join("\n"),
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};

export const readTerminalLogTool: ToolDescriptor<ReadTerminalLogInput, Awaited<ReturnType<typeof readTerminalLog>>> = {
  id: "readTerminalLog",
  displayName: "读取终端日志",
  description: "按行范围或关键字读取超出捕获窗口的终端命令完整输出。",
  modelDescription: "Read the complete saved output of an earlier runTerminalCommand call whose result includes a `log` reference, because its in-memory capture kept only the beginning and end. Give logId from that reference. Read a page of lines from startLine, or pass search to list matching line numbers first and then read around them; continue at nextLine until it is null. `complete: false` means some output was not saved or the command did not finish. This only reads saved output: it does not run commands, and it fails if the folder no longer has terminal access or the log expired.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "读取终端日志", placeholder: "", submitLabel: "", primaryFieldKey: "logId", primaryFieldLabel: "日志", fields: [] },
  inputSchema: readTerminalLogInputSchema,
  execute: async ({ input, signal }) => readTerminalLog(input, terminalGrant, signal),
  buildAssistantText: ({ output }) => output.lines.map(line => `${line.line}: ${line.text}`).join("\n"),
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};
