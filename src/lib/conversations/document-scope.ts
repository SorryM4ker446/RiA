import { readAssistantSnapshot } from "@/lib/assistants/schema";

/**
 * The document collections a conversation searches; empty means the whole
 * library. Only a template narrows it.
 */
export function conversationCollections(chat: { assistantConfig: unknown }): string[] {
  return readAssistantSnapshot(chat.assistantConfig)?.collections ?? [];
}
