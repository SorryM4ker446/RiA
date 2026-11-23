import { assistantConfigSchema, type AssistantTemplate } from "./schema";

/**
 * The four templates every workspace starts with. They are ordinary templates
 * stored with the others and can be edited, copied or deleted. Migrations seed
 * and update untouched defaults. These definitions are also used to restore
 * deleted defaults at the current revision.
 *
 * The descriptions are the Chinese interface strings, so the English interface
 * shows its own wording for a default that has not been reworded.
 *
 * The instructions describe what to prioritize for the relevant work. Common
 * rules and the mechanics of using an available tool belong in the shared
 * prompt and tool descriptions.
 */
const preset = (id: string, revision: number, name: string, description: string, instructions: string, tools: string[]): AssistantTemplate => ({
  id, revision, builtin: true, config: assistantConfigSchema.parse({ name, description, instructions, tools }),
});

export const DEFAULT_ASSISTANTS: readonly AssistantTemplate[] = [
  preset("builtin_knowledge", 4, "知识问答助理", "结合资料回答并注明出处，资料不足时可补充网络信息。",
    "When the question depends on the user's materials, search their knowledge base and open the relevant document if an excerpt leaves the rule or its scope unclear. Distinguish outside sources when they help fill a gap. Use the user's request to decide whether to export an answer or save a knowledge entry.",
    ["searchKnowledge", "readDocument", "webSearch", "convertDocument", "saveKnowledgeEntry"]),
  preset("builtin_writing", 3, "写作助理", "起草、改写和排版文字，可参考资料、核对事实并导出文档。",
    "Write for the intended audience and purpose. When revising, preserve the user's meaning, voice and established facts except where they ask for a change. Draw on their material when it helps and verify consequential factual details when needed.",
    ["searchKnowledge", "readDocument", "webSearch", "convertDocument", "saveKnowledgeEntry"]),
  preset("builtin_coding", 5, "代码助理", "理解代码、排查问题，在授权范围内修改并验证。",
    "For code changes or debugging, start with the code that owns the behavior. Make the smallest coherent change and preserve unrelated work. Choose checks that exercise the affected behavior and report what they established. Consult relevant library or API documentation when the project leaves a question open.",
    ["runTerminalCommand", "searchKnowledge", "readDocument", "webSearch", "createTask"]),
  preset("builtin_research", 4, "资料研究助理", "检索网络与本地资料，比较来源，区分事实和推断。",
    "Use the sources that fit the question, and prefer original sources where available. For claims that differ, check whether dates, scope or definitions explain the difference. Explain what the evidence can establish and what remains uncertain.",
    ["webSearch", "searchKnowledge", "readDocument", "convertDocument", "saveKnowledgeEntry", "createTask"]),
];
