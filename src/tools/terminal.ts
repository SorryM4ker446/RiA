import { bindTerminalApproval, runTerminalCommand } from "@/lib/terminal/runtime";
import { terminalInputSchema, type TerminalInput, type TerminalSessionView } from "@/lib/terminal/schema";
import type { ToolDescriptor } from "./types";
import { jsonSchema, zodSchema } from "ai";

const modelInput = terminalInputSchema.omit({ binding: true });

export const terminalTool: ToolDescriptor<TerminalInput, TerminalSessionView> = {
  id: "runTerminalCommand",
  displayName: "执行终端命令",
  description: "在已开启终端权限的目录中执行 PowerShell 命令，每次执行都需要确认。",
  modelDescription: "Run a non-interactive Windows PowerShell command when the user requests local terminal work. Each exact command and working directory requires user approval. Only use a grantId listed in the terminal-enabled folders below. The working directory is not a sandbox: commands run as the Windows user. Do not use for ordinary questions, guess folder IDs, request credentials, or put secrets in commands/output. Return the actual result; never claim execution before approval. No persistent shell, stdin, interactive prompts or elevated permissions. Commands time out and remaining ordinary child processes are stopped when the shell ends.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "执行终端命令", placeholder: "描述需要执行的操作", submitLabel: "发送", primaryFieldKey: "command", primaryFieldLabel: "PowerShell 命令", fields: [] },
  requiresApproval: true,
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
  execute: ({ input, signal, runId }) => runTerminalCommand(input, signal, runId),
  buildAssistantText: ({ output }) => [output.status, output.stdout, output.stderr, `Exit code: ${output.exitCode ?? "—"}`].filter(Boolean).join("\n"),
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};
