import { type SupportedModelId } from "@/config/model";
import { ModelMode } from "@/features/chat/page-utils";
import { encodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { UIMessage } from "ai";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { chatApi, persistConversationMessage } from "@/features/chat/api-client";
import { buildDefaultManualFieldValues } from "@/features/chat/tool-input";
import type { ManualToolFieldValues, ManualToolSelection, TaskStatusFilter, ToolCatalogItem } from "@/features/chat/types";
import type { useTasks } from "@/features/chat/use-tasks";
type Options = { setMessages: Dispatch<SetStateAction<UIMessage[]>>; ensureActiveChatId: (title: string) => Promise<string>; loadChats: () => Promise<void>; selectedChatModel: SupportedModelId; modelMode: ModelMode; selectedManualTool: ManualToolSelection; setSelectedManualTool: Dispatch<SetStateAction<ManualToolSelection>>; loadTasks: ReturnType<typeof useTasks>["loadTasks"]; taskStatusFilter: TaskStatusFilter; };
export function useTools({ setMessages, ensureActiveChatId, loadChats, selectedChatModel, modelMode, selectedManualTool, setSelectedManualTool, loadTasks, taskStatusFilter }: Options) {
  const [availableTools, setAvailableTools] = useState<ToolCatalogItem[]>([]);
  const [toolCatalogError, setToolCatalogError] = useState<string | null>(null);
  const [hasLoadedToolCatalog, setHasLoadedToolCatalog] = useState(false);
  const [manualToolFieldValues, setManualToolFieldValues] = useState<ManualToolFieldValues>({});
  const [manualToolFieldErrors, setManualToolFieldErrors] = useState<ManualToolFieldValues>({});
  const [isRunningManualTool, setIsRunningManualTool] = useState(false);
  const manualTools = getManualToolsForChat();
  const selectedManualToolConfig = getSelectedManualToolConfig();
  const manualToolSelectValue = selectedManualToolConfig ? selectedManualToolConfig.id : "none";
  const isManualToolSelected = modelMode === "chat" && selectedManualToolConfig !== null;
  function getManualToolsForChat(): ToolCatalogItem[] {
    return availableTools.filter((tool) => tool.manual.enabled && tool.modeSupport.includes("chat"));
  }

  function getSelectedManualToolConfig(): ToolCatalogItem | null {
    if (selectedManualTool === "none") return null;
    return getManualToolsForChat().find((tool) => tool.id === selectedManualTool) ?? null;
  }

  async function loadToolCatalog() {
    try {
      const payload = await chatApi.listTools();
      const tools = Array.isArray(payload.data) ? payload.data : [];
      setAvailableTools(tools);
      setToolCatalogError(null);
    } catch (error) {
      setAvailableTools([]);
      setToolCatalogError(error instanceof Error ? error.message : "读取工具目录失败");
    } finally {
      setHasLoadedToolCatalog(true);
    }
  }

  async function runManualTool(params: {
    tool: string;
    input: Record<string, unknown>;
    userVisibleText: string;
  }) {
    const chatId = await ensureActiveChatId(params.userVisibleText || `手动工具调用: ${params.tool}`);
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const toolCallId = crypto.randomUUID();
    const toolType = `tool-${params.tool}` as const;

    const userMessage: UIMessage = {
      id: userMessageId,
      role: "user",
      parts: [{ type: "text", text: params.userVisibleText || `手动调用工具 ${params.tool}` }],
    };

    const pendingAssistantMessage: UIMessage = {
      id: assistantMessageId,
      role: "assistant",
      parts: [
        { type: "text", text: `正在执行 ${params.tool}...` },
        {
          type: toolType,
          toolCallId,
          state: "input-available",
          input: params.input,
        } as UIMessage["parts"][number],
      ],
    };

    setMessages((prev) => [...prev, userMessage, pendingAssistantMessage]);
    setIsRunningManualTool(true);

    try {
      await persistConversationMessage({
        chatId,
        role: "user",
        content: params.userVisibleText || `手动调用工具 ${params.tool}`,
        clientMessageId: userMessageId,
      });

      const payload = await chatApi.runTool(params.tool, params.input, selectedChatModel);
      const summary =
        typeof payload.assistantText === "string" && payload.assistantText.trim()
          ? payload.assistantText.trim()
          : `已完成工具「${params.tool}」调用。`;

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
              ...message,
              parts: [
                { type: "text", text: summary },
                {
                  type: toolType,
                  toolCallId,
                  state: "output-available",
                  input: params.input,
                  output: payload.data,
                } as UIMessage["parts"][number],
              ],
            }
            : message,
        ),
      );

      await persistConversationMessage({
        chatId,
        role: "assistant",
        content: encodePersistedAssistantToolMessage({
          type: "assistant-tool-message",
          text: summary,
          tools: [
            {
              toolName: params.tool,
              toolCallId,
              state: "output-available",
              input: params.input,
              output: payload.data,
            },
          ],
        }),
        clientMessageId: assistantMessageId,
      });

      if (params.tool === "createTask") {
        await loadTasks(taskStatusFilter, { silent: true });
      }

      await loadChats();
    } catch (error) {
      const errorText = error instanceof Error ? error.message : `${params.tool} 执行失败`;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantMessageId
            ? {
              ...message,
              parts: [
                { type: "text", text: "工具执行失败。" },
                {
                  type: toolType,
                  toolCallId,
                  state: "output-error",
                  input: params.input,
                  errorText,
                } as UIMessage["parts"][number],
              ],
            }
            : message,
        ),
      );

      try {
        await persistConversationMessage({
          chatId,
          role: "assistant",
          content: encodePersistedAssistantToolMessage({
            type: "assistant-tool-message",
            text: "工具执行失败。",
            tools: [
              {
                toolName: params.tool,
                toolCallId,
                state: "output-error",
                input: params.input,
                errorText,
              },
            ],
          }),
          clientMessageId: assistantMessageId,
          status: "error",
        });
        await loadChats();
      } catch {
        // Keep UI responsive even if persistence fails.
      }

      throw error;
    } finally {
      setIsRunningManualTool(false);
    }
  }
  useEffect(() => { void loadToolCatalog(); }, []);
  useEffect(() => {
    if (!hasLoadedToolCatalog) return;
    if (manualTools.length === 0) return;
    if (selectedManualTool === "none") return;
    const exists = manualTools.some((tool) => tool.id === selectedManualTool);
    if (!exists) {
      setSelectedManualTool("none");
    }
  }, [hasLoadedToolCatalog, manualTools, selectedManualTool, setSelectedManualTool]);
  useEffect(() => {
    if (selectedManualToolConfig) {
      setManualToolFieldValues((prev) => {
        const defaults = buildDefaultManualFieldValues(selectedManualToolConfig);
        const next: ManualToolFieldValues = {};
        for (const field of selectedManualToolConfig.manual.fields) {
          if (typeof prev[field.key] === "string") {
            next[field.key] = prev[field.key];
            continue;
          }
          if (typeof defaults[field.key] === "string") {
            next[field.key] = defaults[field.key];
          }
        }
        return next;
      });
      return;
    }
    setManualToolFieldValues({});
    setManualToolFieldErrors({});
  }, [selectedManualToolConfig]);
  return {
    toolCatalogError, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors,
    setManualToolFieldErrors, isRunningManualTool, manualTools, selectedManualToolConfig,
    manualToolSelectValue, isManualToolSelected, runManualTool,
  };
}

