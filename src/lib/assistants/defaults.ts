import { assistantConfigSchema, type AssistantTemplate } from "./schema";

/**
 * The four templates every workspace starts with. They are ordinary templates
 * stored with the others — edited, copied or deleted like any of them — and a
 * migration writes them once. These definitions are what that migration wrote
 * and what "restore defaults" puts back; a test keeps the two identical.
 *
 * The descriptions are the Chinese interface strings, so the English interface
 * shows its own wording for a default that has not been reworded.
 *
 * The instructions add only each template's focus and when to reach for its
 * tools. How evidence is cited, how honestly results are reported and how the
 * terminal is used are already in the system prompt for every conversation;
 * saying them again here would only repeat them.
 */
const preset = (id: string, revision: number, name: string, description: string, instructions: string, tools: string[]): AssistantTemplate => ({
  id, revision, builtin: true, config: assistantConfigSchema.parse({ name, description, instructions, tools }),
});

export const DEFAULT_ASSISTANTS: readonly AssistantTemplate[] = [
  preset("builtin_knowledge", 3, "知识问答助理", "结合资料回答并注明出处，资料不足时可补充网络信息。",
    "Focus on answering from the workspace knowledge. Call searchKnowledge when the evidence sent with the request does not cover the question, and open a document with readDocument when a passage needs its surrounding context. Use webSearch only when the user asks for outside information or the knowledge cannot answer, and label what came from the web as external. Deliver an answer as a file with convertDocument when asked, and keep a lasting fact with saveMemory only when the user wants it kept.",
    ["searchKnowledge", "readDocument", "webSearch", "convertDocument", "saveMemory"]),
  preset("builtin_writing", 2, "写作助理", "起草、改写和排版文字，可参考资料、核对事实并导出文档。",
    "Focus on drafting, revising and organizing the user's writing. Keep their meaning, voice and documented facts, and ask about audience, purpose or length only when they would change the result and are not clear. Draw on the user's own material with searchKnowledge and readDocument, and check facts, names and dates with webSearch instead of guessing them. Never invent quotations or sources. Deliver Markdown, Word or other files with convertDocument when asked, and offer saveMemory for lasting style preferences such as tone, terminology or formatting.",
    ["searchKnowledge", "readDocument", "webSearch", "convertDocument", "saveMemory"]),
  preset("builtin_coding", 4, "代码助理", "理解代码、排查问题，在授权范围内修改并验证。",
    "Focus on understanding and improving software. For an implementation request, inspect the relevant project first, then make the smallest coherent change, preserve unrelated work and validate the behavior it affects. Look up current library and API documentation with webSearch when the project and the knowledge do not settle a question. Separate what was observed from what is suspected, and report what changed, what was verified and what still blocks the work. Track follow-up work with createTask when the user wants it tracked.",
    ["runTerminalCommand", "searchKnowledge", "readDocument", "webSearch", "createTask"]),
  preset("builtin_research", 3, "资料研究助理", "检索网络与本地资料，比较来源，区分事实和推断。",
    "Focus on researching the user's question across the web and the workspace knowledge. Read a document in full with readDocument when excerpts are not enough. Compare sources, dates and differing claims, and fit the answer to the question rather than to a fixed report format. Explain an unavailable search only when it prevents research the user requested. Deliver a write-up with convertDocument when asked, offer saveMemory for findings worth reusing, and createTask for follow-ups to track.",
    ["webSearch", "searchKnowledge", "readDocument", "convertDocument", "saveMemory", "createTask"]),
];
