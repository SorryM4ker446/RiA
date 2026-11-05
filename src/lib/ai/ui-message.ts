import { thinkingRecordSchema, type ThinkingRecord } from "@/lib/chat/thinking";
import { messageInvocationSchema, readMessageInvocation, type MessageInvocation } from "@/lib/chat/invocation-schema";
import { documentDiagnosticsSchema, type DocumentDiagnostics } from "@/lib/documents/diagnostics";
import { UIMessage } from "ai";
import { z } from "zod";
import { documentSourceSchema, type DocumentSource } from "@/lib/documents/types";
import { contextReportSchema, type ContextReport } from "@/lib/chat/context-report";

export type PersistedFilePart = {
  url: string;
  mediaType: string;
  filename?: string;
  assetId?: string;
  relativePath?: string;
};

export type PersistedUserMessagePayload = {
  type: "user-message";
  text: string;
  files: PersistedFilePart[];
  /** What the user chose in the composer for this message. */
  invocation?: MessageInvocation;
};

export type PersistedAssistantToolItem = {
  title?: string;
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

export type PersistedAssistantToolMessagePayload = {
  type: "assistant-tool-message";
  text: string;
  tools: PersistedAssistantToolItem[];
  /**
   * The model's chain of thought for this answer.
   *
   * Some providers require it to travel back with the next request that uses
   * tools, and the only copy that exists is here — the model will not produce
   * it again on demand. It is protocol state rather than content, so it is
   * kept with the message and not shown in the conversation, but it is stored
   * locally and included in workspace backups like everything else in a
   * message. Its size follows the model's tool loop, independently of the
   * user text-input limit.
   */
  reasoning?: string;
  /** What kind of reasoning the turn had, how long it took and where tools broke it up. */
  thinking?: ThinkingRecord;
  /**
   * The turn step by step, as the model produced it. A later request repeats it in
   * this order, so a provider's prompt cache keeps matching it.
   */
  steps?: PersistedStep[];
  /** Optional tools this turn could not use, recorded for the note below. */
  unavailableTools?: string[];
  /** The tool the user chose for this turn, when the model answered without calling it. */
  skippedTool?: string;
  documentSources?: DocumentSource[];
  documentDiagnostics?: DocumentDiagnostics;
  runId?: string;
  runIds?: string[];
  modelLabel?: string;
  contextBudget?: ContextReport;
};

export const USER_MESSAGE_PREFIX = "__USER_MESSAGE__:";
export const ASSISTANT_TOOL_MESSAGE_PREFIX = "__ASSISTANT_TOOL_MESSAGE__:";

/** The model's chain of thought for a message, if it produced one. */
export function getReasoningFromUIMessage(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part): part is { type: "reasoning"; text: string } => part.type === "reasoning" && typeof (part as { text?: unknown }).text === "string")
    .map(part => part.text)
    .join("")
    .trim();
}

export function getTextFromUIMessage(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];

  const text = parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (text.length > 0) {
    return text;
  }

  const legacyContent = (message as { content?: unknown }).content;
  if (typeof legacyContent === "string") {
    return legacyContent.trim();
  }

  return "";
}

export function getLatestUserMessage(messages: UIMessage[]): {
  id?: string;
  text: string;
  files: PersistedFilePart[];
  invocation: MessageInvocation | null;
} | null {
  const userMessages = messages.filter((message) => message.role === "user");
  const latest = userMessages[userMessages.length - 1];
  if (!latest) return null;

  const text = getTextFromUIMessage(latest);
  const files = (latest.parts ?? [])
    .filter((part): part is Extract<(typeof latest.parts)[number], { type: "file" }> => part.type === "file")
    .map((part) => ({
      url: part.url,
      mediaType: part.mediaType,
      ...(part.filename ? { filename: part.filename } : {}),
    }));

  if (!text && files.length === 0) return null;
  return { id: latest.id, text, files, invocation: readMessageInvocation(latest.metadata) };
}

export function encodePersistedUserMessage(payload: PersistedUserMessagePayload): string {
  return `${USER_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

export function decodePersistedUserMessage(content: string): PersistedUserMessagePayload | null {
  if (!content.startsWith(USER_MESSAGE_PREFIX)) return null;
  const raw = content.slice(USER_MESSAGE_PREFIX.length);

  try {
    const parsed = JSON.parse(raw) as PersistedUserMessagePayload;
    if (!parsed || parsed.type !== "user-message") return null;
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.files)) return null;

    const validFiles = parsed.files.filter(
      (file) =>
        file &&
        typeof file.url === "string" &&
        file.url.length > 0 &&
        typeof file.mediaType === "string" &&
        file.mediaType.length > 0,
    );

    const invocation = messageInvocationSchema.safeParse(parsed.invocation);
    return {
      type: "user-message",
      text: parsed.text,
      ...(invocation.success ? { invocation: invocation.data } : {}),
      files: validFiles.map((file) => ({
        url: file.url,
        mediaType: file.mediaType,
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
        ...(typeof file.assetId === "string" ? { assetId: file.assetId } : {}),
        ...(typeof file.relativePath === "string" ? { relativePath: file.relativePath } : {}),
      })),
    };
  } catch {
    return null;
  }
}

export type PersistedStep = { reasoning?: string; text?: string; calls: string[] };

const persistedStepSchema = z.object({ reasoning: z.string().optional(), text: z.string().optional(), calls: z.array(z.string()) });

/** Where the steps of a response begin and what each held. A single step needs no record. */
export function stepsOfMessage(parts: UIMessage["parts"]): PersistedStep[] | undefined {
  const steps: PersistedStep[] = [{ calls: [] }];
  for (const part of parts) {
    const step = steps.at(-1)!;
    if (part.type === "step-start") { if (step.calls.length || step.text || step.reasoning) steps.push({ calls: [] }); }
    else if (part.type === "reasoning") step.reasoning = `${step.reasoning ?? ""}${part.text}`;
    else if (part.type === "text") step.text = `${step.text ?? ""}${part.text}`;
    else if ("toolCallId" in part && typeof part.toolCallId === "string") step.calls.push(part.toolCallId);
  }
  return steps.some(step => step.calls.length) ? steps : undefined;
}

export function encodePersistedAssistantToolMessage(
  payload: PersistedAssistantToolMessagePayload,
): string {
  return `${ASSISTANT_TOOL_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

export function decodePersistedAssistantToolMessage(
  content: string,
): PersistedAssistantToolMessagePayload | null {
  if (!content.startsWith(ASSISTANT_TOOL_MESSAGE_PREFIX)) return null;
  const raw = content.slice(ASSISTANT_TOOL_MESSAGE_PREFIX.length);

  try {
    const parsed = JSON.parse(raw) as PersistedAssistantToolMessagePayload;
    if (!parsed || parsed.type !== "assistant-tool-message") return null;
    if (typeof parsed.text !== "string" || !Array.isArray(parsed.tools)) return null;
    // A stored reasoning that is not a string is dropped rather than carried on
    // as something the request schema would later reject.
    const reasoning = typeof (parsed as { reasoning?: unknown }).reasoning === "string"
      ? (parsed as { reasoning: string }).reasoning
      : undefined;
    const unavailableTools = Array.isArray((parsed as { unavailableTools?: unknown }).unavailableTools)
      ? ((parsed as { unavailableTools: unknown[] }).unavailableTools).filter((value): value is string => typeof value === "string").slice(0, 8)
      : undefined;

    const tools = parsed.tools
      .filter(
        (tool) =>
          tool &&
          typeof tool.toolName === "string" &&
          tool.toolName.length > 0 &&
          typeof tool.toolCallId === "string" &&
          tool.toolCallId.length > 0 &&
          typeof tool.state === "string" &&
          tool.state.length > 0,
      )
      .map((tool) => ({
        ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 500) } : {}),
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        state: tool.state,
        ...(tool.input !== undefined ? { input: tool.input } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        ...(typeof tool.errorText === "string" ? { errorText: tool.errorText } : {}),
        ...(tool.approval && typeof tool.approval.id === "string" ? {
          approval: {
            id: tool.approval.id,
            ...(typeof tool.approval.approved === "boolean" ? { approved: tool.approval.approved } : {}),
            ...(typeof tool.approval.reason === "string" ? { reason: tool.approval.reason } : {}),
          },
        } : {}),
      }));

    return {
      type: "assistant-tool-message",
      text: parsed.text,
      ...(typeof parsed.runId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(parsed.runId) ? { runId: parsed.runId } : {}),
      ...(Array.isArray(parsed.runIds) ? { runIds: [...new Set(parsed.runIds.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))].slice(-100) } : {}),
      ...(typeof parsed.modelLabel === "string" ? { modelLabel: parsed.modelLabel.slice(0, 240) } : {}),
      ...(contextReportSchema.safeParse(parsed.contextBudget).success ? { contextBudget: contextReportSchema.parse(parsed.contextBudget) } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(thinkingRecordSchema.safeParse(parsed.thinking).success ? { thinking: thinkingRecordSchema.parse(parsed.thinking) } : {}),
      ...(z.array(persistedStepSchema).safeParse(parsed.steps).success ? { steps: z.array(persistedStepSchema).parse(parsed.steps) } : {}),
      ...(unavailableTools?.length ? { unavailableTools } : {}),
      ...(typeof parsed.skippedTool === "string" ? { skippedTool: parsed.skippedTool.slice(0, 100) } : {}),
      tools,
      ...(documentDiagnosticsSchema.safeParse(parsed.documentDiagnostics).success ? { documentDiagnostics: documentDiagnosticsSchema.parse(parsed.documentDiagnostics) } : {}),
      ...(Array.isArray(parsed.documentSources) ? { documentSources: parsed.documentSources.slice(0, 8).flatMap(source => {
        const result = documentSourceSchema.safeParse(source);
        return result.success ? [result.data] : [];
      }) } : {}),
    };
  } catch {
    return null;
  }
}

export function truncateTitle(input: string, maxLength = 60): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

/** A stored or streamed tool error as a sentence; errors are stored as the API's JSON shape. */
export function readToolError(errorText: string) {
  try {
    const message = (JSON.parse(errorText) as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === "string" && message ? message : errorText;
  } catch {
    return errorText;
  }
}
