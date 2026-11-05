/**
 * Tool ids that have since changed. Old conversations, templates and backups keep the
 * old one, and a part naming a tool the catalog no longer has would otherwise make every
 * later message in that conversation fail validation.
 */
const RENAMED_TOOLS: Readonly<Record<string, string>> = { saveMemory: "saveKnowledgeEntry" };

export const currentToolId = (id: string) => RENAMED_TOOLS[id] ?? id;
export const legacyToolIds = Object.keys(RENAMED_TOOLS);
