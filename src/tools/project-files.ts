import { jsonSchema, zodSchema } from "ai";
import { conversationApprovalRule } from "@/lib/local-files/workspace";
import { runsWithoutAsking } from "@/lib/approvals/rules";
import {
  applyProjectEdit, bindProjectEdit, editProjectFileFields, editProjectFileInputSchema, readProjectFile, readProjectFileInputSchema,
  type EditProjectFileInput, type ProjectEditResult, type ReadProjectFileInput,
} from "@/lib/project-files/service";
import type { ToolDescriptor } from "./types";

export const readProjectFileTool: ToolDescriptor<ReadProjectFileInput, Awaited<ReturnType<typeof readProjectFile>>> = {
  id: "readProjectFile",
  displayName: "读取项目文件",
  description: "打开项目里的文本文件，改之前先看清楚。",
  modelDescription: "Read a UTF-8 text file in the workspace folder by line range, before editing it or to inspect code and configuration. Returns numbered lines, totalLines, nextLine (continue there until null) and the file's hash, which editProjectFile requires as expectedHash. Use it instead of terminal commands such as Get-Content when you need exact text to edit. Paths are relative to the folder; repository internals (.git) and credential files are not available. Binary, UTF-16 or very large files are refused; use the terminal for those. This only reads; it never changes files.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: { follows: "runTerminalCommand" } },
  inputSchema: readProjectFileInputSchema,
  execute: async ({ input, signal }) => readProjectFile(input, signal),
};

// The model never supplies a binding; the server computes it from the file.
const modelEditSchema = editProjectFileFields.omit({ binding: true });

export const editProjectFileTool: ToolDescriptor<EditProjectFileInput, ProjectEditResult> = {
  id: "editProjectFile",
  displayName: "编辑项目文件",
  description: "精确修改或新建文件，改动可以先给你过目。",
  modelDescription: "Change a UTF-8 text file in the workspace folder by exact replacement, or create one. Prefer this to PowerShell for editing source code, configuration and documents: no quoting or encoding is involved. First read the file with readProjectFile and pass its hash as expectedHash. Each edit's oldText must match the current file exactly once (copy it with indentation and line breaks, without the line-number prefix); set replaceAll to change every occurrence. All edits are located in the file as read, must not overlap, and are applied together or not at all. Use content instead of edits to create a new file (omit expectedHash) or rewrite a whole file. The file keeps its line endings and BOM. The conversation's approval rule decides whether the user approves the shown diff first: under ask they do; under acceptEdits and full the edit is written directly. On failure nothing is written and the error says what to do: re-read when the file changed, add context when oldText is ambiguous. Use runTerminalCommand to run, build or test, and to rename, move or delete files.",
  modeSupport: ["chat"],
  surface: { category: "workspace", user: null, template: { follows: "runTerminalCommand" } },
  requiresApproval: async (_input, context) => !runsWithoutAsking(await conversationApprovalRule(context.chatId), "edit"),
  inputSchema: editProjectFileInputSchema,
  modelInputSchema: jsonSchema<EditProjectFileInput>(() => zodSchema(modelEditSchema).jsonSchema, { validate: async value => {
    const parsed = editProjectFileInputSchema.safeParse(value);
    // Binding here means an edit that cannot apply is reported to the model
    // immediately, and the approval shows the diff that will be written.
    return parsed.success ? { success: true, value: await bindProjectEdit(parsed.data) } : { success: false, error: parsed.error };
  } }),
  bindForApproval: bindProjectEdit,
  execute: async ({ input, signal }) => applyProjectEdit(input, signal),
};
