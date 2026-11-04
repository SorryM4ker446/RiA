import { COMPACT_CONTEXT_TOOL } from "@/lib/chat/compact-context";
import { TERMINAL_COMPANION_TOOLS } from "./terminal-companions";

/**
 * Whether an assistant template permits a tool. A template lists the capabilities
 * it grants: reading enabled skill guidance and compacting the conversation's own
 * context grant nothing external, and the file and log tools are ways of using
 * the terminal access it lists. Offering a tool, describing it to the model and
 * approving a call to it all ask here, so they cannot disagree.
 */
export function templateAllowsTool(allowed: readonly string[], toolId: string) {
  return allowed.includes(toolId) || toolId === "readPluginSkill" || toolId === COMPACT_CONTEXT_TOOL
    || (TERMINAL_COMPANION_TOOLS.has(toolId) && allowed.includes("runTerminalCommand"));
}
