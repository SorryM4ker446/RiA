import { jsonSchema, zodSchema } from "ai";
import { terminalGrant } from "@/lib/terminal/runtime";
import {
  applyProjectEdit, bindProjectEdit, editProjectFileFields, editProjectFileInputSchema, readProjectFile, readProjectFileInputSchema,
  type EditProjectFileInput, type ProjectEditResult, type ReadProjectFileInput,
} from "@/lib/project-files/service";
import type { ToolDescriptor } from "./types";

export const readProjectFileTool: ToolDescriptor<ReadProjectFileInput, Awaited<ReturnType<typeof readProjectFile>>> = {
  id: "readProjectFile",
  displayName: "读取项目文件",
  description: "在开启终端权限的目录中按行读取文本文件。",
  modelDescription: "Read a UTF-8 text file in a terminal-enabled folder by line range, before editing it or to inspect code and configuration. Returns numbered lines, totalLines, nextLine (continue there until null) and the file's hash, which editProjectFile requires as expectedHash. Use it instead of terminal commands such as Get-Content when you need exact text to edit. Paths are relative to the folder; repository internals (.git) and credential files are not available. Binary, UTF-16 or very large files are refused; use the terminal for those. This only reads; it never changes files.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "读取项目文件", placeholder: "", submitLabel: "", primaryFieldKey: "path", primaryFieldLabel: "文件", fields: [] },
  inputSchema: readProjectFileInputSchema,
  execute: async ({ input, signal }) => readProjectFile(input, signal),
  buildAssistantText: ({ output }) => output.lines.map(line => `${line.line}: ${line.text}`).join("\n"),
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};

// The model never supplies a binding; the server computes it from the file.
const modelEditSchema = editProjectFileFields.omit({ binding: true });

export const editProjectFileTool: ToolDescriptor<EditProjectFileInput, ProjectEditResult> = {
  id: "editProjectFile",
  displayName: "编辑项目文件",
  description: "在开启终端权限的目录中精确替换文本或创建文件，审批时显示差异。",
  modelDescription: "Change a UTF-8 text file in a terminal-enabled folder by exact replacement, or create one. Prefer this to PowerShell for editing source code, configuration and documents: no quoting or encoding is involved. First read the file with readProjectFile and pass its hash as expectedHash. Each edit's oldText must match the current file exactly once (copy it with indentation and line breaks, without the line-number prefix); set replaceAll to change every occurrence. All edits are located in the file as read, must not overlap, and are applied together or not at all. Use content instead of edits to create a new file (omit expectedHash) or rewrite a whole file. The file keeps its line endings and BOM. The folder's terminalApprovalMode decides whether the user approves the shown diff first. On failure nothing is written and the error says what to do: re-read when the file changed, add context when oldText is ambiguous. Use runTerminalCommand to run, build or test, and to rename, move or delete files.",
  modeSupport: ["chat"],
  manual: { enabled: false, label: "编辑项目文件", placeholder: "", submitLabel: "", primaryFieldKey: "path", primaryFieldLabel: "文件", fields: [] },
  requiresApproval: async input => (await terminalGrant(editProjectFileInputSchema.parse(input).grantId)).terminalApprovalMode !== "full-access",
  inputSchema: editProjectFileInputSchema,
  modelInputSchema: jsonSchema<EditProjectFileInput>(() => zodSchema(modelEditSchema).jsonSchema, { validate: async value => {
    const parsed = editProjectFileInputSchema.safeParse(value);
    // Binding here means an edit that cannot apply is reported to the model
    // immediately, and the approval shows the diff that will be written.
    return parsed.success ? { success: true, value: await bindProjectEdit(parsed.data) } : { success: false, error: parsed.error };
  } }),
  bindForApproval: bindProjectEdit,
  execute: async ({ input, signal }) => applyProjectEdit(input, signal),
  buildAssistantText: ({ output }) => `${output.created ? "Created" : "Edited"} ${output.path} (+${output.added} -${output.removed})\n${output.diff}`,
  memory: { enabled: false, minQuality: 1, summarize: () => null },
};
