import { getToolDescriptor } from "./builtins";

/**
 * Whether an assistant template permits a tool. Offering a tool, describing it to
 * the model and approving a call to it all ask here, so they cannot disagree.
 */
export function templateAllowsTool(allowed: readonly string[], toolId: string) {
  if (allowed.includes(toolId)) return true;
  const rule = getToolDescriptor(toolId)?.surface.template;
  return rule === "always" || (rule === "with-any" && allowed.length > 0) || (typeof rule === "object" && allowed.includes(rule.follows));
}
