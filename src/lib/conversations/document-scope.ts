import { readAssistantSnapshot } from "@/lib/assistants/schema";
import { decodeDocumentScope } from "@/lib/documents/scope";

type ScopedConversation = { topicId: string | null; assistantConfig: unknown; documentScope: string };

/**
 * The knowledge topics a conversation is limited to; empty means the whole library.
 * A topic conversation keeps the topic's selection, and otherwise only a template
 * narrows it. A value stored by an earlier version, or left behind when a topic was
 * deleted, has no control that shows it, so it does not count.
 */
export function conversationCollections(chat: ScopedConversation): string[] {
  if (chat.topicId) return decodeDocumentScope(chat.documentScope);
  return readAssistantSnapshot(chat.assistantConfig)?.collections ?? [];
}
