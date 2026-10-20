import { bindTerminalApproval, runTerminalCommand, terminalGrant } from "@/lib/terminal/runtime";
import { terminalInputSchema, type TerminalInput, type TerminalCommandResult } from "@/lib/terminal/schema";
import type { ToolDescriptor } from "./types";
import { jsonSchema, zodSchema } from "ai";

const modelInput = terminalInputSchema.omit({ binding: true, timeoutSeconds: true });

export const terminalTool: ToolDescriptor<TerminalInput, TerminalCommandResult> = {
  id: "runTerminalCommand",
  displayName: "执行终端命令",
  description: "在授权目录使用 PowerShell 和已安装的开发工具完成任务，支持完全访问或逐条审批。",
  modelDescription: "Use installed executables discovered through inherited PATH/PATHEXT and development-tool environment variables, including Python, Go and Node.js. Discover commands with Get-Command or where.exe; do not assume a runtime is installed or install it without a user request. The folder is the working directory for project tasks. Run a non-interactive Windows PowerShell command for requested local file or development work. Within a terminal-enabled folder you can list and search files, read source code and documents, create folders and files of any format, edit or overwrite existing files, copy, move, rename and delete, and run development commands. Use PowerShell for these operations rather than treating the limited Markdown/TXT convenience tools as a restriction on terminal access. Use explicit paths and preserve unrelated files. No extra folder permission is needed for each operation after terminal access is granted; the folder's terminalApprovalMode determines approval. In approval mode each tool call requires user approval of the exact command and working directory; in full-access mode commands execute automatically without per-call approval. Only use a grantId listed in the terminal-enabled folders below. The working directory is not a sandbox: commands run as the Windows user. Do not use for ordinary questions, guess folder IDs, request credentials, or put secrets in commands/output. Return the actual result; never claim execution before the tool returns a result. No persistent shell, stdin, interactive prompts or elevated permissions. Commands have no automatic execution timeout. The user can stop a running command; remaining ordinary child processes are stopped when the shell ends.",
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
