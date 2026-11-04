import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { activeSkillPackages } from "@/lib/plugins/store";
import { resolveToolDescriptor, toolAvailability } from "@/tools/registry";
import { templateAllowsTool } from "@/tools/template-access";
import type { ModelRef } from "@/lib/models/preferences-schema";
import type { MessageInvocation } from "./invocation-schema";

export type ResolvedInvocation = {
  /** Offered alone on the turn's first step, so the model reaches for it first. */
  toolId: string | null;
  /** The text placed with the user's message; it states the choice and carries any skill's instructions. */
  directive: string;
};

/**
 * Turns the user's choice into what this turn does, checked against what is true
 * now: the menu the choice came from may be older than a settings change. A
 * choice that cannot be honoured refuses the message rather than quietly sending
 * it as something else, and the composer puts the draft back.
 */
export async function resolveInvocation(invocation: MessageInvocation, context: { allowedToolIds?: string[]; modelSupportsTools: boolean; modelRef?: ModelRef; usesMemory?: boolean }): Promise<ResolvedInvocation> {
  const lines: string[] = [];
  let toolId: string | null = null;
  if (invocation.tool) {
    const tool = await resolveToolDescriptor(invocation.tool.id);
    if (!tool?.surface.user) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.chat.invocation.toolNotCallable") });
    if (context.allowedToolIds && !templateAllowsTool(context.allowedToolIds, tool.id)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.chat.invocation.toolNotInTemplate") });
    if (tool.id === "saveMemory" && context.usesMemory === false) throw new ApiError({ code: "VALIDATION_ERROR", message: t("tools.saveMemory.disabled") });
    if (!context.modelSupportsTools) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.chat.invocation.modelCannotCallTools") });
    if (!(await toolAvailability(tool.id, context.modelRef)).available) throw new ApiError({ code: "CONFIGURATION_ERROR", message: t("lib.chat.invocation.toolUnavailable") });
    // Reading an attached file needs no call: its text already travels with the message.
    if (tool.id !== "readDocument" || invocation.document) toolId = tool.id;
    if (toolId) {
      lines.push(`The user chose the tool ${toolId} for this message. Call it first unless that is impossible, and say so if you could not.`);
      if (invocation.document) lines.push(`The document they selected: ${JSON.stringify({ documentId: invocation.document.id, filename: invocation.document.filename })}.`);
      if (invocation.format) lines.push(`The output format they selected: ${invocation.format}.`);
    }
  }
  if (invocation.skills?.length) {
    const active = await activeSkillPackages();
    for (const chosen of invocation.skills) {
      const found = active.find(item => item.row.packageId === chosen.packageId);
      const skill = found?.manifest.skills.find(item => item.id === chosen.skillId);
      if (!found || !skill) throw new ApiError({ code: "NOT_FOUND", message: t("lib.chat.invocation.skillUnavailable") });
      lines.push(`The user chose the skill ${JSON.stringify(skill.name)} (package ${found.row.packageId}) for this message. Follow its instructions within the rules above:\n${skill.instructions}`);
    }
  }
  return { toolId, directive: lines.length ? `[Chosen by the user for this message]\n${lines.join("\n")}\n[The user's message follows]` : "" };
}
