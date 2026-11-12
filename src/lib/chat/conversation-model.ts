import { db } from "@/db";
import { readAssistantSnapshot, type AssistantSnapshot } from "@/lib/assistants/schema";
import { preferredModel } from "@/lib/models/preferences";
import type { ModelPreferences, ModelRef } from "@/lib/models/preferences-schema";
import { taskModel } from "@/lib/scheduler/jobs";
import { readTaskEffort } from "@/lib/scheduler/task-settings";

/** What a conversation is read with to know who decides how its turns run. */
export const conversationModelSelect = {
  assistantConfig: true,
  ephemeral: true,
  scheduledJobs: { select: { modelProvider: true, modelId: true, usesMemory: true, reasoningEffort: true }, take: 1 },
} as const;

type TaskSettings = { modelProvider: string | null; modelId: string | null; usesMemory: boolean; reasoningEffort: string | null };
type PolicySource = { assistantConfig: unknown; ephemeral: boolean; scheduledJobs: TaskSettings[] };

/**
 * Who decides how a conversation's turns run, and what they are bound to.
 *
 * A task's conversation is the task's own general-assistant conversation: no
 * template applies to it, and the task alone decides its model, whether it
 * uses long-term memory and how hard the model reasons, for a turn the task
 * started and one the user typed alike. The default chat model stands in while
 * the task names none. Any other conversation is bound only by a template that
 * names a model, keeps its own memory switch, and reasons as the app is set to.
 */
export async function conversationModel(chat: PolicySource | null, thinking?: ModelPreferences["thinking"]): Promise<{
  task: boolean; assistant: AssistantSnapshot | null; bound: ModelRef | null; memoryOff: boolean | undefined; thinking: ModelPreferences["thinking"] | undefined;
}> {
  const task = chat?.scheduledJobs[0];
  if (task) {
    const effort = readTaskEffort(task.reasoningEffort);
    return {
      task: true, assistant: null, bound: taskModel(task) ?? await preferredModel("chat"), memoryOff: !task.usesMemory,
      thinking: effort === null ? thinking : effort === "off" ? { enabled: false, effort: null } : { enabled: true, effort },
    };
  }
  const assistant = readAssistantSnapshot(chat?.assistantConfig);
  return { task: false, assistant, bound: assistant?.model ?? null, memoryOff: chat?.ephemeral, thinking };
}

/** The model a conversation's own work uses when no request names one. */
export async function conversationModelOf(chatId: string): Promise<ModelRef> {
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: conversationModelSelect });
  return preferredModel("chat", (await conversationModel(chat)).bound);
}

/** Whether long-term memory is off for a conversation: the task's switch for a task's conversation. */
export async function conversationMemoryOff(chatId: string): Promise<boolean | null> {
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { ephemeral: true, scheduledJobs: { select: { usesMemory: true }, take: 1 } } });
  if (!chat) return null;
  const task = chat.scheduledJobs[0];
  return task ? !task.usesMemory : chat.ephemeral;
}
