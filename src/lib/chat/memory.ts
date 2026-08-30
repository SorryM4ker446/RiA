import { resolveModelId } from "@/config/model";
import {
  truncateTitle,
  type PersistedAssistantToolItem
} from "@/lib/ai/ui-message";
import { saveMemory } from "@/lib/memory/store";
import { persistToolMemory } from "@/tools/memory-policy";

const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";
export async function rememberUserMessage(userId: string, text: string | undefined) {
  if (text) {
    const rememberPattern =
      /^(remember|记住|请记住)\s*[:：\-]?\s*(.+)$/i.exec(text.trim()) ??
      /^我的(.+?)是(.+)$/i.exec(text.trim());

    if (rememberPattern) {
      const memoryContent = rememberPattern[2]?.trim() ?? "";
      const keyHint = rememberPattern[1]?.trim() ?? "preference";

      if (memoryContent) {
        await saveMemory({
          userId,
          key: truncateTitle(keyHint || "user_memory", 40),
          value: memoryContent,
          score: 0.9,
        });
      }
    }
  }

}
export async function persistResponseToolMemories({ userId, chatId, toolItems, assistantText, modelId }: { userId: string; chatId: string; toolItems: PersistedAssistantToolItem[]; assistantText: string; modelId: ReturnType<typeof resolveModelId> }) {
  if (toolItems.length > 0) {
    const memoryResults = await Promise.allSettled(
      toolItems.map((toolItem) =>
        persistToolMemory({
          userId,
          toolId: toolItem.toolName,
          trigger: "auto",
          state: toolItem.state,
          input: toolItem.input,
          output: toolItem.output,
          assistantText,
          modelId,
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

