import { type PersistedAssistantToolItem } from "@/lib/ai/ui-message";
import { persistToolMemory } from "@/tools/memory-policy";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";
import type { ModelRef } from "@/lib/models/preferences-schema";

const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";
export async function persistResponseToolMemories({ chatId, toolItems, assistantText, modelRef }: { chatId: string; toolItems: PersistedAssistantToolItem[]; assistantText: string; modelRef: ModelRef }) {
  if (toolItems.length > 0) {
    const memoryResults = await Promise.allSettled(
      toolItems.map((toolItem) =>
        persistToolMemory({
          workspaceId: LOCAL_WORKSPACE_ID,
          toolId: toolItem.toolName,
          trigger: "auto",
          state: toolItem.state,
          input: toolItem.input,
          output: toolItem.output,
          assistantText,
          modelRef,
        }),
      ),
    );

    if (TOOL_DEBUG) {
      const decisions = memoryResults.map((result) =>
        result.status === "fulfilled" ? result.value.reason : "error",
      );
      console.info("chat.auto-tool.memory", {
        chatId,
        toolCount: toolItems.length,
        decisions,
      });
    }
  }
}
