import { ModelMode } from "@/features/chat/page-utils";
import { encodePersistedAssistantToolMessage } from "@/lib/ai/ui-message";
import { t } from "@/lib/locale";
import { UIMessage } from "ai";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { chatApi, persistConversationMessage } from "@/features/chat/api-client";
import { buildDefaultManualFieldValues } from "@/features/chat/tool-input";
import type { ManualToolFieldValues, ManualToolSelection, TaskStatusFilter, ToolCatalogItem, ToolDocumentSelection } from "@/features/chat/types";
import type { useTasks } from "@/features/chat/use-tasks";
import type { ModelRef } from "@/lib/models/preferences-schema";
type Options = { activeChatId: string | null; allowedToolIds?: string[]; setMessages: Dispatch<SetStateAction<UIMessage[]>>; ensureActiveChatId: (title: string) => Promise<string>; loadChats: () => Promise<void>; selectedChatModel: ModelRef | null; modelMode: ModelMode; loadTasks: ReturnType<typeof useTasks>["loadTasks"]; taskStatusFilter: TaskStatusFilter; };
export function useTools({ activeChatId, allowedToolIds, setMessages, ensureActiveChatId, loadChats, selectedChatModel, modelMode, loadTasks, taskStatusFilter }: Options) {
  const [selectedManualTool, setSelectedManualTool] = useState<ManualToolSelection>("none");
  const [selectedToolDocument, setSelectedToolDocument] = useState<ToolDocumentSelection | null>(null);
  const previousChat = useRef(activeChatId);
  const manualRun = useRef(false);
  const currentChat = useRef(activeChatId); currentChat.current = activeChatId;
  const [availableTools, setAvailableTools] = useState<ToolCatalogItem[]>([]);
  const catalogRequest = useRef(0);
  const [toolCatalogError, setToolCatalogError] = useState<string | null>(null);
  const [hasLoadedToolCatalog, setHasLoadedToolCatalog] = useState(false);
  const [manualToolFieldValues, setManualToolFieldValues] = useState<ManualToolFieldValues>({});
  const [manualToolFieldErrors, setManualToolFieldErrors] = useState<ManualToolFieldValues>({});
  const [isRunningManualTool, setIsRunningManualTool] = useState(false);
  useEffect(() => {
    const previous = previousChat.current; previousChat.current = activeChatId;
    if (previous === activeChatId || (previous === null && manualRun.current)) return;
    setSelectedManualTool("none"); setSelectedToolDocument(null);
  }, [activeChatId]);
  const manualTools = getManualToolsForChat();
  // Surfaced in the picker so the absence is explained where the user looks
  // for it, rather than as a tool that silently is not there.
  const unavailableTools = availableTools.filter((tool) => !tool.available && tool.modeSupport.includes("chat"));
  const selectedManualToolConfig = getSelectedManualToolConfig();
  const manualConfiguration = selectedManualToolConfig ? JSON.stringify({ id: selectedManualToolConfig.id, manual: selectedManualToolConfig.manual }) : null;
  const previousManualConfiguration = useRef<string | null | undefined>(undefined);
  const manualToolSelectValue = selectedManualToolConfig ? selectedManualToolConfig.id : "none";
  const isManualToolSelected = modelMode === "chat" && selectedManualToolConfig !== null;
  function getManualToolsForChat(): ToolCatalogItem[] {
    // A tool that cannot run is not offered as a manual action either: the
    // user is told why instead of pressing a button that only errors.
    return availableTools.filter((tool) => (allowedToolIds === undefined || allowedToolIds.includes(tool.id)) && tool.manual.enabled && tool.available && tool.modeSupport.includes("chat"));
  }

  function getSelectedManualToolConfig(): ToolCatalogItem | null {
    if (selectedManualTool === "none") return null;
    return getManualToolsForChat().find((tool) => tool.id === selectedManualTool) ?? null;
  }

  async function loadToolCatalog() {
    const request = ++catalogRequest.current;
    try {
      const payload = await chatApi.listTools();
      if (request !== catalogRequest.current) return;
      const tools = Array.isArray(payload.data) ? payload.data : [];
      setAvailableTools(tools);
      setToolCatalogError(null);
    } catch (error) {
      if (request !== catalogRequest.current) return;
      setAvailableTools([]);
      setToolCatalogError(error instanceof Error ? error.message : t("chatApi.listToolsFailed"));
    } finally {
      if (request === catalogRequest.current) setHasLoadedToolCatalog(true);
    }
  }

  async function runManualTool(params: {
    tool: string;
    input: Record<string, unknown>;
    userVisibleText: string;
  }) {
    if (manualRun.current) throw new Error("请等待当前工具执行完成。");
    manualRun.current = true; setIsRunningManualTool(true);
    try {
      const startingChat = currentChat.current;
      const chatId = await ensureActiveChatId(params.userVisibleText || `${t("tools.manualCallTitlePrefix")} ${params.tool}`);
      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      const toolCallId = crypto.randomUUID();
      const toolType = `tool-${params.tool}` as const;

      const userMessage: UIMessage = {
        id: userMessageId,
        role: "user",
        parts: [{ type: "text", text: params.userVisibleText || `${t("tools.manualCallTextPrefix")} ${params.tool}` }],
      };

      const pendingAssistantMessage: UIMessage = {
        id: assistantMessageId,
        role: "assistant",
        parts: [
          { type: "text", text: `${t("tools.runningPrefix")} ${params.tool}...` },
          {
            type: toolType,
            toolCallId,
            state: "input-available",
            input: params.input,
          } as UIMessage["parts"][number],
        ],
      };

      if (currentChat.current === chatId || (startingChat === null && currentChat.current === null)) {
        setMessages((prev) => [...prev, userMessage, pendingAssistantMessage]);
      }

      try {
        await persistConversationMessage({
          chatId,
          role: "user",
          content: params.userVisibleText || `${t("tools.manualCallTextPrefix")} ${params.tool}`,
          clientMessageId: userMessageId,
        });

        const payload = await chatApi.runTool(params.tool, params.input, selectedChatModel, chatId);
        const summary =
          typeof payload.assistantText === "string" && payload.assistantText.trim()
            ? payload.assistantText.trim()
            : `${t("tools.completedPrefix")}${params.tool}${t("tools.completedSuffix")}`;

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
        const isCurrent = currentChat.current === chatId;
        if (isCurrent) {
          setSelectedManualTool(current => current === params.tool ? "none" : current);
          setSelectedToolDocument(null);
        }
        return { chatId, isCurrent };
      } catch (error) {
        const errorText = error instanceof Error ? error.message : `${params.tool} ${t("chatApi.runToolFailed")}`;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessageId
              ? {
                ...message,
                parts: [
                  { type: "text", text: t("tools.failedText") },
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
              text: t("tools.failedText"),
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

        if (currentChat.current !== chatId) return { chatId, isCurrent: false };
        throw error;
      }
    } finally { manualRun.current = false; setIsRunningManualTool(false); }
  }
  useEffect(() => { void loadToolCatalog(); }, []);
  useEffect(() => {
    if (!hasLoadedToolCatalog) return;
    if (selectedManualTool === "none") return;
    const exists = manualTools.some((tool) => tool.id === selectedManualTool);
    if (!exists) {
      setSelectedManualTool("none");
    }
  }, [hasLoadedToolCatalog, manualTools, selectedManualTool, setSelectedManualTool]);
  useEffect(() => {
    // Refreshing availability must not clear a selected document or tool draft.
    if (previousManualConfiguration.current === manualConfiguration) return;
    previousManualConfiguration.current = manualConfiguration;
    setSelectedToolDocument(null);
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
  }, [selectedManualToolConfig, manualConfiguration]);
  return {
    selectedManualTool, setSelectedManualTool, selectedToolDocument, setSelectedToolDocument,
    toolCatalogError, unavailableTools, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors,
    setManualToolFieldErrors, isRunningManualTool, manualTools, selectedManualToolConfig,
    manualToolSelectValue, isManualToolSelected, runManualTool, loadToolCatalog,
  };
}
