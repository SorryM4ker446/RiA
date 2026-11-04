import { t, tf } from "@/lib/locale";
import type { ModelMode, UploadableFilePart } from "@/features/chat/page-utils";
import { encodePersistedAssistantToolMessage, encodePersistedUserMessage, type PersistedAssistantToolItem } from "@/lib/ai/ui-message";
import type { MessageInvocation } from "@/lib/chat/invocation-schema";
import { formatLabels, type ExportFormat } from "@/lib/document-processor/schema";
import { assetIdFromUrl } from "@/lib/media/message-codec";
import { UIMessage } from "ai";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatApi, persistConversationMessage } from "@/features/chat/api-client";
import type { SkillCatalogItem, ToolCatalogItem, ToolDocumentSelection } from "@/features/chat/types";

/** What the composer has chosen for the next message: at most one tool, and any number of skills. */
export type ComposerChoice = { tool: ToolCatalogItem | null; skills: SkillCatalogItem[]; document: ToolDocumentSelection | null; format: ExportFormat };
export const EMPTY_CHOICE: ComposerChoice = { tool: null, skills: [], document: null, format: "docx" };
/** The tool that needs a document chosen beside the text. */
export const DOCUMENT_TOOLS = new Set(["readDocument", "convertDocument"]);

export const toolLabel = (tool: ToolCatalogItem) => tool.extensionName ? tool.displayName.slice(tool.extensionName.length + 3) || tool.displayName : tool.displayName;

export function invocationOf(choice: ComposerChoice, localize: (value: string) => string): MessageInvocation | null {
  if (!choice.tool && !choice.skills.length) return null;
  return {
    ...(choice.tool ? { tool: { id: choice.tool.id, label: choice.tool.extensionId ? toolLabel(choice.tool) : localize(choice.tool.displayName) } } : {}),
    ...(choice.skills.length ? { skills: choice.skills.map(skill => ({ packageId: skill.packageId, skillId: skill.skillId, label: skill.name })) } : {}),
    ...(choice.tool && DOCUMENT_TOOLS.has(choice.tool.id) && choice.document ? { document: { id: choice.document.id, filename: choice.document.filename } } : {}),
    ...(choice.tool?.id === "convertDocument" ? { format: choice.format } : {}),
  };
}

type Options = { activeChatId: string | null; isHistoryReady: boolean; setMessages: Dispatch<SetStateAction<UIMessage[]>>; reloadMessages: (chatId: string) => Promise<void>; ensureActiveChatId: (title: string, shouldActivate?: () => boolean) => Promise<string>; loadChats: () => Promise<void>; modelMode: ModelMode };

export function useTools({ activeChatId, isHistoryReady, setMessages, reloadMessages, ensureActiveChatId, loadChats, modelMode }: Options) {
  const [tools, setTools] = useState<ToolCatalogItem[]>([]);
  const [skills, setSkills] = useState<SkillCatalogItem[]>([]);
  const [toolCatalogError, setToolCatalogError] = useState<string | null>(null);
  const [choice, setChoice] = useState<ComposerChoice>(EMPTY_CHOICE);
  const [isConverting, setIsConverting] = useState(false);
  const converting = useRef(false);
  const catalogRequest = useRef(0);
  const previousChat = useRef(activeChatId);
  // What is on screen now. A send that creates its conversation replaces the chat
  // instance partway through, so the one it started with can no longer show anything.
  const viewRef = useRef({ chatId: activeChatId, ready: isHistoryReady, setMessages, reloadMessages });
  useEffect(() => { viewRef.current = { chatId: activeChatId, ready: isHistoryReady, setMessages, reloadMessages }; });

  const loadToolCatalog = useCallback(async () => {
    const request = ++catalogRequest.current;
    try {
      const payload = await chatApi.listTools();
      if (request !== catalogRequest.current) return;
      setTools(Array.isArray(payload.data) ? payload.data : []);
      setSkills(Array.isArray(payload.skills) ? payload.skills : []);
      setToolCatalogError(null);
    } catch (error) {
      if (request !== catalogRequest.current) return;
      setToolCatalogError(error instanceof Error ? error.message : t("chatApi.listToolsFailed"));
    }
  }, []);
  useEffect(() => { void loadToolCatalog(); }, [loadToolCatalog]);

  // A choice belongs to the message being written in this conversation. A send has
  // already taken its choice by the time it creates one, and puts it back on failure.
  useEffect(() => {
    const previous = previousChat.current; previousChat.current = activeChatId;
    if (previous !== activeChatId) setChoice(EMPTY_CHOICE);
  }, [activeChatId]);
  useEffect(() => { if (modelMode !== "chat") setChoice(EMPTY_CHOICE); }, [modelMode]);

  const chooseTool = useCallback((tool: ToolCatalogItem) => setChoice(current => current.tool?.id === tool.id ? { ...current, tool: null, document: null } : { ...current, tool, document: null }), []);
  const toggleSkill = useCallback((skill: SkillCatalogItem) => setChoice(current => {
    const chosen = current.skills.some(item => item.packageId === skill.packageId && item.skillId === skill.skillId);
    return { ...current, skills: chosen ? current.skills.filter(item => item.packageId !== skill.packageId || item.skillId !== skill.skillId) : [...current.skills, skill] };
  }), []);
  const removeLastChoice = useCallback(() => setChoice(current => current.skills.length ? { ...current, skills: current.skills.slice(0, -1) } : { ...current, tool: null, document: null }), []);
  const removeTool = useCallback(() => setChoice(current => ({ ...current, tool: null, document: null })), []);
  const setToolDocument = useCallback((document: ToolDocumentSelection | null) => setChoice(current => ({ ...current, document })), []);
  const setToolFormat = useCallback((format: ExportFormat) => setChoice(current => ({ ...current, format })), []);
  const clearChoice = useCallback(() => setChoice(EMPTY_CHOICE), []);

  // A tool that was disabled or removed since it was chosen does not stay chosen.
  const hasChosenTool = useMemo(() => !choice.tool || tools.some(tool => tool.id === choice.tool!.id && tool.available), [choice.tool, tools]);
  useEffect(() => { if (tools.length && !hasChosenTool) removeTool(); }, [tools.length, hasChosenTool, removeTool]);

  /**
   * One click from a file to a converted copy, with no model involved. Each source
   * is its own call: one unreadable file does not cost the others their result.
   */
  async function convertDocuments(params: { files: UploadableFilePart[]; document: ToolDocumentSelection | null; format: ExportFormat; text: string; invocation: MessageInvocation }) {
    if (converting.current) throw new Error(t("ui.chat.use-tools.waitForTheCurrentToolTo"));
    converting.current = true; setIsConverting(true);
    try {
      const sources = params.files.length
        ? params.files.map(file => ({ label: file.filename || t("mediaGen.untitledFile"), input: { attachmentId: assetIdFromUrl(file.url) ?? "", format: params.format } }))
        : params.document ? [{ label: params.document.filename, input: { documentId: params.document.id, format: params.format } }] : [];
      const text = params.text || tf("chat.convert.request", { format: formatLabels[params.format] });
      const origin = viewRef.current.chatId;
      const chatId = await ensureActiveChatId(sources[0]?.label ?? text, () => viewRef.current.chatId === origin);
      const userMessageId = crypto.randomUUID(), assistantMessageId = crypto.randomUUID();
      const calls = sources.map(source => ({ ...source, toolCallId: crypto.randomUUID() }));
      const part = (call: (typeof calls)[number], fields: Record<string, unknown>) => ({ type: "tool-convertDocument", toolCallId: call.toolCallId, input: call.input, ...fields }) as unknown as UIMessage["parts"][number];
      // Only a conversation already open can show progress; a new one shows the stored result below.
      const shownLive = origin === chatId && viewRef.current.chatId === chatId && viewRef.current.ready;
      if (shownLive) viewRef.current.setMessages(previous => [...previous,
        { id: userMessageId, role: "user", metadata: { invocation: params.invocation }, parts: [{ type: "text", text }, ...params.files] },
        { id: assistantMessageId, role: "assistant", parts: [{ type: "text", text: t("chat.convert.running") }, ...calls.map(call => part(call, { state: "input-available" }))] },
      ]);
      await persistConversationMessage({ chatId, role: "user", content: encodePersistedUserMessage({ type: "user-message", text, files: params.files.map(file => ({ url: file.url, mediaType: file.mediaType, ...(file.filename ? { filename: file.filename } : {}) })), invocation: params.invocation }), clientMessageId: userMessageId });
      const results = await Promise.all(calls.map(async call => {
        try { return { call, output: (await chatApi.runTool("convertDocument", call.input, chatId)).data }; }
        catch (error) { return { call, errorText: error instanceof Error ? error.message : t("chatApi.runToolFailed") }; }
      }));
      const failed = results.filter(result => "errorText" in result).length;
      const summary = failed === results.length ? t("chat.convert.failed") : failed ? tf("chat.convert.partlyDone", { done: results.length - failed, failed }) : t("chat.convert.done");
      const items: PersistedAssistantToolItem[] = results.map(result => ({ toolName: "convertDocument", toolCallId: result.call.toolCallId, input: result.call.input, ...("errorText" in result ? { state: "output-error", errorText: result.errorText } : { state: "output-available", output: result.output }) }));
      await persistConversationMessage({ chatId, role: "assistant", content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: summary, tools: items }), clientMessageId: assistantMessageId, ...(failed === results.length ? { status: "error" } : {}) });
      // Whoever moved on to another conversation finds this one complete when they return.
      const view = viewRef.current;
      if (view.chatId === chatId) {
        if (shownLive && view.ready) view.setMessages(previous => previous.map(message => message.id === assistantMessageId ? { ...message, parts: [{ type: "text", text: summary }, ...results.map(result => part(result.call, "errorText" in result ? { state: "output-error", errorText: result.errorText } : { state: "output-available", output: result.output }))] } : message));
        else await view.reloadMessages(chatId);
      }
      await loadChats();
      return { failed: failed === results.length };
    } finally { converting.current = false; setIsConverting(false); }
  }

  return { tools, skills, toolCatalogError, loadToolCatalog, choice, setChoice, chooseTool, toggleSkill, removeLastChoice, removeTool, setToolDocument, setToolFormat, clearChoice, isConverting, convertDocuments };
}
