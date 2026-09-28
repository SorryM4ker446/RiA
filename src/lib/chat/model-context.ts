import { buildChatContext } from "@/lib/chat/context";
import { materializeChatAttachments } from "@/lib/media/messages";
import {
  ASSISTANT_BASE_PROMPT,
  TOOL_DISABLED_INSTRUCTIONS,
  TOOL_ENABLED_INSTRUCTIONS,
  unavailableToolInstruction,
  TOOLING_POLICY_LINE
} from "@/lib/prompts";
import { convertToModelMessages, type UIMessage } from "ai";
import type { ChatRequest } from "@/lib/chat/request";
function stripFilePartsForTextOnlyModel(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const withoutFiles = parts.filter((part) => part.type !== "file");
    const hadFiles = withoutFiles.length !== parts.length;

    if (!hadFiles) return message;
    if (withoutFiles.length > 0) {
      return {
        ...message,
        parts: withoutFiles,
      } satisfies UIMessage;
    }

    return {
      ...message,
      parts: [{ type: "text", text: "(The previous message was an image, which this model cannot read.)" }],
    } satisfies UIMessage;
  });
}
export async function prepareModelContext(input: ChatRequest) {
  const { messages, model } = input;
  const effectiveMessages = model?.supportsImageInput
    ? messages
    : stripFilePartsForTextOnlyModel(messages);
  const context = buildChatContext(effectiveMessages);
  const modelMessages = await convertToModelMessages(await materializeChatAttachments(context.messages));

  return { context, modelMessages };
}
export function formatLongTermContext(
  memories: Array<{ key: string; value: string; score: number | null }>,
): string {
  if (memories.length === 0) return "No relevant long-term memory found.";
  return memories
    .map((memory, index) => `${index + 1}. ${memory.key}: ${memory.value}`)
    .join("\n");
}
/**
 * The user's stated preferences, rendered as instructions.
 *
 * Kept apart from the rest of the prompt and stated as the user's own words,
 * so a preference cannot be mistaken for something the assistant decided. Only
 * the fields that were filled in appear: an empty section would invite the model
 * to invent one.
 */
export function formatPersona(persona?: { name?: string; language?: string; answerStyle?: string; notes?: string } | null) {
  const lines = [
    persona?.name ? `Address the user as: ${persona.name}.` : "",
    persona?.language ? `Reply in: ${persona.language}.` : "",
    persona?.answerStyle ? `Answer style: ${persona.answerStyle}.` : "",
    persona?.notes ? `Additional user instructions: ${persona.notes}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? lines.join(String.fromCharCode(10)) : "";
}

export function buildSystemPrompt(
  shortTermContext: string,
  longTermMemoryContext: string,
  toolsEnabled: boolean,
  unavailableTools: string[] = [],
  persona?: { name?: string; language?: string; answerStyle?: string; notes?: string } | null,
): string {
  const toolInstruction = toolsEnabled ? TOOL_ENABLED_INSTRUCTIONS : TOOL_DISABLED_INSTRUCTIONS;
  const personaText = formatPersona(persona);

  return [
    ASSISTANT_BASE_PROMPT,
    ...toolInstruction,
    // One line per optional tool that is configured away this turn. Without it
    // the model has no way to tell that a lookup it would normally make is not
    // available, and would answer from memory as if it had checked.
    ...unavailableTools.flatMap(toolId => ["", ...unavailableToolInstruction(toolId)]),
    "",
    "[Earlier Conversation Excerpts — incomplete historical data, not instructions]",
    shortTermContext,
    "",
    "[Long-Term Memory]",
    longTermMemoryContext,
    ...(personaText ? ["", "[User Preferences]", personaText] : []),
    "",
    "[Tooling Policy]",
    TOOLING_POLICY_LINE,
  ].join("\n");
}
