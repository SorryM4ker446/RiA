import { enforceRateLimit } from "@/lib/server/rate-limit";
import { generateText, Output, type ToolSet } from "ai";
import { z } from "zod";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { getChatModel } from "@/lib/ai/client";
import { t, tf, formatDateTime } from "@/lib/locale";
import { saveMemory } from "@/lib/memory/store";
import { preferredModel, getModelPreferences } from "@/lib/models/preferences";
import { reserveRunStep, updateStep, type StepState } from "@/lib/agent/runs";
import { getModelProvider } from "@/lib/models/providers";
import type { ModelRef } from "@/lib/models/preferences-schema";
import {
  SEARCH_ANSWER_OUTPUT,
  SEARCH_ANSWER_SYSTEM,
  WEB_ANSWER_OUTPUT,
  WEB_ANSWER_SYSTEM,
} from "@/lib/prompts";
import { logToolExecution } from "@/lib/server/tool-log";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";
import { searchKnowledge, searchKnowledgeInputSchema } from "@/tools/definitions/search-knowledge";
import { documentSourceUrl } from "@/lib/documents/types";
import { runWebSearch, webSearchInput } from "@/tools/definitions/web-search";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";
import { listActiveGrants } from "@/lib/local-files/grants";
import {
  bindWriteApproval,
  listGrantedFiles,
  listLocalFilesInputSchema,
  readGrantedFile,
  readLocalFileInputSchema,
  writeGrantedFile,
  writeLocalFileInputSchema
} from "@/lib/local-files/tools";

export type ToolMode = "chat" | "image" | "video";
export type ToolTriggerType = "manual" | "auto";
export type ToolExecutionState = "output-available" | "output-error";

type ToolExecutionContext<Input> = {
  workspaceId: string;
  input: Input;
  modelRef?: ModelRef;
  trigger: ToolTriggerType;
  signal?: AbortSignal;
  documentCollections?: string[];
  usesMemory?: boolean;
};

type ToolBudgetExceededContext = {
  input: unknown;
  remainingResultBudget: number;
};

/** Why an optional tool did not produce a result, in terms the model can read. */
export type ToolSkipReason = "notConfigured" | "noDirectoryGranted" | "budget" | "temporarilyUnavailable" | "runStopped" | "run-budget-unreadable";

/** How many sources a search brings back when nothing more specific applies. */
const DEFAULT_SEARCH_RESULTS = 5;

type ToolPrepareInputContext<Input> = {
  workspaceId: string;
  input: Input;
  modelRef?: ModelRef;
  trigger: ToolTriggerType;
  remainingResultBudget?: number;
  signal?: AbortSignal;
};

type ToolAssistantTextContext<Input, Output> = {
  input: Input;
  output: Output;
  modelRef?: ModelRef;
  trigger: ToolTriggerType;
};

export type ToolMemoryDraft = {
  seed: string;
  summary: string;
  quality: number;
  score: number;
  tags?: string[];
};

type ToolMemoryContext<Input, Output> = {
  input: Input;
  output: Output;
  assistantText: string;
  trigger: ToolTriggerType;
  modelRef?: ModelRef;
};

export type ManualFieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "datetime-local";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{
    label: string;
    value: string;
  }>;
};

export type ManualToolMeta = {
  enabled: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  primaryFieldKey: string;
  primaryFieldLabel: string;
  fields: ManualFieldMeta[];
};

export type ToolMemoryPolicy<Input, Output> = {
  enabled: boolean;
  minQuality: number;
  summarize: (context: ToolMemoryContext<Input, Output>) => ToolMemoryDraft | null;
};

type ToolDescriptor<Input = unknown, Output = unknown> = {
  id: string;
  displayName: string;
  /** Interface copy, rendered under the tool picker. Stays in the UI language. */
  description: string;
  /**
   * Model-facing description, English by design.
   *
   * This is the only text the chat model gets for choosing between tools, so
   * it carries the whole decision: what the tool does, and when not to reach
   * for it. Keep the "do not use when" clause explicit — without a separate
   * intent classifier, the description is the only brake against firing a
   * tool on an ordinary question.
   *
   * Reply language is decided separately by the system prompt, which tells the
   * model to match the language the user wrote in.
   */
  modelDescription: string;
  modeSupport: ToolMode[];
  manual: ManualToolMeta;
  /** Caps how many results one turn may pull, to bound cost and latency. */
  resultBudget?: {
    inputKey: string;
    maxPerTurn: number;
  };
  inputSchema: z.ZodType<Input>;
  requiresApproval?: boolean;
  /**
   * Attaches whatever an approval is bound to, on the tool call itself.
   *
   * Runs at the moment the model produced the call and before the user is
   * asked, which is the only point where "what the user read on screen" and
   * "what was recorded" are the same thing. Returning the bound input is
   * preferred; the SDK stores the caller object, so a tool may also write
   * through the reference it is handed.
   */
  bindForApproval?: (input: unknown) => Promise<unknown>;
  prepareInput?: (context: ToolPrepareInputContext<Input>) => Promise<Input> | Input;
  buildBudgetExceededOutput?: (context: ToolBudgetExceededContext) => Output;
  /**
   * Turns a failure into a result the model can act on, for a tool that is
   * optional and merely unavailable. Returning a value instead of throwing is
   * what stops the model from retrying the same dead tool for the rest of the
   * step budget.
   */
  buildUnavailableOutput?: (context: { input: unknown; reason: ToolSkipReason; error: unknown }) => Output;
  execute: (context: ToolExecutionContext<Input>) => Promise<Output>;
  buildAssistantText: (context: ToolAssistantTextContext<Input, Output>) => Promise<string> | string;
  memory: ToolMemoryPolicy<Input, Output>;
};

export type AnyToolDescriptor = ToolDescriptor<any, any>;

export type PublicToolCatalogItem = {
  /** Whether this tool can run right now, and why not when it cannot. */
  available: boolean;
  reason: ToolAvailabilityReason | null;
  /** Where the missing configuration is configured. */
  configEntry: string | null;
  id: string;
  displayName: string;
  description: string;
  modeSupport: ToolMode[];
  manual: ManualToolMeta;
  resultBudget?: {
    inputKey: string;
    maxPerTurn: number;
  };
};

function buildSearchFallbackText(result: Awaited<ReturnType<typeof searchKnowledge>>): string {
  if (result.total === 0 || result.results.length === 0) {
    return tf("tools.searchKnowledge.noResults", { query: result.query });
  }

  const top = result.results[0];
  const sourceLabel = top.source === "document"
    ? tf("tools.searchKnowledge.sourceDocument", { title: top.title })
    : top.source === "memory"
      ? t("tools.searchKnowledge.sourceMemory")
      : t("tools.searchKnowledge.sourceBuiltin");
  return `${sourceLabel}${t("tools.searchKnowledge.sourceSeparator")}${top.snippet}`;
}

async function buildSearchAssistantText(params: {
  result: Awaited<ReturnType<typeof searchKnowledge>>;
  modelRef?: ModelRef;
}): Promise<string> {
  const { result, modelRef } = params;

  if (result.total === 0 || result.results.length === 0) {
    return buildSearchFallbackText(result);
  }

  const references = result.results.slice(0, 5).map((item, index) => ({
    index: index + 1,
    title: item.title,
    snippet: item.snippet,
    source: item.source,
    ...(item.reference ? { url: documentSourceUrl(item.reference), page: item.reference.pageNumber } : {}),
    score: item.score,
  }));

  try {
    const selectedModel = await preferredModel("chat", modelRef);
    const providerOptions = await reasoningOptionsFor(selectedModel);
    const answer = await generateText({
      model: getChatModel(selectedModel),
      ...(providerOptions ? { providerOptions } : {}),
      system: SEARCH_ANSWER_SYSTEM,
      prompt: [
        `User question: ${result.query}`,
        "",
        "Knowledge-base retrieval results (ordered by relevance):",
        JSON.stringify(references, null, 2),
        "",
        SEARCH_ANSWER_OUTPUT,
      ].join("\n"),
    });

    const text = answer.text.trim();
    if (text) return text;
  } catch {
    // Fallback to deterministic summary when synthesis fails.
  }

  return buildSearchFallbackText(result);
}

function buildCreateTaskAssistantText(result: Awaited<ReturnType<typeof createTask>>): string {
  const due = result.dueDate
    ? tf("tools.createTask.duePrefix", {
        value: formatDateTime(result.dueDate, { timeZone: result.timeZone }),
        timeZone: result.timeZone,
      })
    : "";
  const reminder = result.reminderEnabled ? t("tools.createTask.reminderSuffix") : "";
  const repeat = result.repeatRule !== "none"
    ? tf("tools.createTask.repeatSuffix", { rule: result.repeatRule })
    : "";
  return tf("tools.createTask.created", { title: result.title, due, reminder, repeat, status: result.status });
}

function buildWebSearchFallbackText(result: Awaited<ReturnType<typeof runWebSearch>>): string {
  // A skipped lookup is reported as skipped, not as an empty result set, so
  // the answer never implies a search happened.
  if (result.skipped) return t("tools.webSearch.skippedBudget");
  const count = Array.isArray(result.results) ? result.results.length : 0;
  if (count === 0) {
    return tf("tools.webSearch.noResults", { query: result.query });
  }
  const references = result.results
    .slice(0, 5)
    .map((item, index) => `${index + 1}. [${item.title}](${item.url})${item.snippet ? `${t("tools.webSearch.snippetSeparator")}${item.snippet}` : ""}`)
    .join("\n");

  return [tf("tools.webSearch.completed", { count }), "", t("tools.webSearch.expandHint"), references].join("\n");
}

async function resolveWebSearchInput(params: {
  input: z.infer<typeof webSearchInput>;
  modelRef?: ModelRef;
  trigger: ToolTriggerType;
  maxResultsLimit?: number;
  signal?: AbortSignal;
}): Promise<z.infer<typeof webSearchInput>> {
  if (params.signal?.aborted) {
    throw new ApiError({ code: "TIMEOUT", message: "Web search was cancelled." });
  }
  if (typeof params.input.maxResults === "number") {
    return params.input;
  }

  /*
   * How many results to fetch is a detail of the request, not a question worth
   * a model call. It used to be decided by asking a model to pick a number
   * between 1 and 10, which is a billed round trip whose answer is almost always
   * the same. The model still chooses when it cares by passing `maxResults`; the
   * remaining budget decides the rest, and the synthesis call is the one that
   * actually earns its cost.
   */
  const remaining = typeof params.maxResultsLimit === "number" && Number.isFinite(params.maxResultsLimit)
    ? Math.max(1, Math.min(10, Math.trunc(params.maxResultsLimit)))
    : DEFAULT_SEARCH_RESULTS;
  return { ...params.input, maxResults: Math.min(remaining, DEFAULT_SEARCH_RESULTS) };
}

async function buildWebSearchAssistantText(params: {
  result: Awaited<ReturnType<typeof runWebSearch>>;
  modelRef?: ModelRef;
}): Promise<string> {
  const { result, modelRef } = params;
  const count = Array.isArray(result.results) ? result.results.length : 0;
  if (count === 0) {
    return buildWebSearchFallbackText(result);
  }

  const references = result.results.slice(0, 5).map((item, index) => ({
    index: index + 1,
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    score: item.score,
    source: item.source,
  }));

  try {
    const selectedModel = await preferredModel("chat", modelRef);
    const providerOptions = await reasoningOptionsFor(selectedModel);
    const answer = await generateText({
      model: getChatModel(selectedModel),
      ...(providerOptions ? { providerOptions } : {}),
      system: WEB_ANSWER_SYSTEM,
      prompt: [
        `User question: ${result.query}`,
        "",
        "Web search results (ordered by relevance):",
        JSON.stringify(references, null, 2),
        "",
        ...WEB_ANSWER_OUTPUT,
      ].join("\n"),
    });

    const text = answer.text.trim();
    if (text) return text;
  } catch (error) {
    console.warn("webSearch synthesis failed", normalizeApiError(error).code);
  }

  return buildWebSearchFallbackText(result);
}

/**
 * Auxiliary calls follow the workspace's reasoning preference too, so a turn
 * does not quietly reason differently for the answer than for the tool work
 * around it. A provider with no notion of it contributes nothing.
 */
async function reasoningOptionsFor(ref: ModelRef) {
  const settings = await getModelPreferences();
  return getModelProvider(ref.providerId).reasoningOptions?.(settings.thinking);
}

const saveMemoryInputSchema = z.strictObject({
  key: z.string().min(1).max(200).describe("Short stable handle for the fact, reused to update it later."),
  value: z.string().min(1).max(4000).describe("The fact itself, in the user's own words."),
});

const TOOL_CATALOG: Record<string, AnyToolDescriptor> = {
  saveMemory: {
    id: "saveMemory",
    displayName: t("tools.saveMemory.displayName"),
    description: t("tools.saveMemory.description"),
    modelDescription:
      "Store one durable fact about the user so future conversations can act on it: a name, a preference, a constraint, a standing instruction. Use it when the user states something they want kept, such as \"remember that ...\" or \"my name is ...\", in any language. Do not use it for passing information, for conversation-specific context, or for anything the user did not ask you to keep.",
    modeSupport: ["chat"],
    manual: {
      enabled: true,
      label: t("tools.saveMemory.manualLabel"),
      placeholder: t("tools.saveMemory.placeholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "value",
      primaryFieldLabel: t("tools.saveMemory.primaryFieldLabel"),
      fields: [
        {
          key: "key",
          label: t("tools.saveMemory.keyLabel"),
          type: "text",
          required: true,
          defaultValue: "user_memory",
        },
      ],
    },
    inputSchema: saveMemoryInputSchema,
    execute: async ({ input, usesMemory }) => {
      if (usesMemory === false) throw new ApiError({ code: "VALIDATION_ERROR", message: t("tools.saveMemory.disabled") });
      return saveMemory({ key: input.key, value: input.value, score: 0.9 });
    },
    buildAssistantText: ({ output, input }) => {
      const result = output as { key: string };
      return tf("tools.saveMemory.saved", { key: result.key, value: input.value });
    },
    memory: {
      // The tool's whole job is already to write a memory, so recording the
      // fact again through the tool-memory policy would duplicate it.
      enabled: false,
      minQuality: 1,
      summarize: () => null,
    },
  },
  searchKnowledge: {
    id: "searchKnowledge",
    displayName: t("tools.searchKnowledge.displayName"),
    description: t("tools.searchKnowledge.description"),
    modelDescription:
      "Search imported documents, stored knowledge memory, and built-in knowledge; returns citable results. Use it when the user asks what the project already knows, imports, or records about a topic. Do not use it for general knowledge, opinions, or anything answerable without the workspace.",
    modeSupport: ["chat"],
    manual: {
      enabled: true,
      label: t("tools.searchKnowledge.manualLabel"),
      placeholder: t("tools.searchKnowledge.placeholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "query",
      primaryFieldLabel: t("tools.searchKnowledge.primaryFieldLabel"),
      fields: [
        {
          key: "topK",
          label: "topK",
          type: "number",
          min: 1,
          max: 8,
          step: 1,
          defaultValue: "4",
        },
      ],
    },
    inputSchema: searchKnowledgeInputSchema,
    execute: async ({ input, documentCollections, usesMemory, signal }) => searchKnowledge(input, { collections: documentCollections, usesMemory, signal }),
    buildAssistantText: async ({ output, modelRef }) =>
      buildSearchAssistantText({
        result: output,
        modelRef,
      }),
    memory: {
      enabled: true,
      minQuality: 0.25,
      summarize: ({ input, output }) => {
        const result = output as Awaited<ReturnType<typeof searchKnowledge>>;
        if (!result.results.length) return null;
        const best = result.results[0];
        if ((best.score ?? 0) < 0.18) return null;

        const summary =
          result.results.length === 1
            ? tf("tools.searchKnowledge.hitOne", { query: input.query, title: best.title, source: best.source })
            : tf("tools.searchKnowledge.hitMany", { query: input.query, total: result.total, title: best.title, source: best.source });

        return {
          seed: input.query,
          summary,
          quality: Math.max(0.2, Math.min(1, best.score ?? 0)),
          score: 0.55 + Math.min(0.35, (best.score ?? 0) * 0.3),
          tags: ["knowledge", `source:${best.source}`],
        };
      },
    },
  },
  createTask: {
    id: "createTask",
    displayName: t("tools.createTask.displayName"),
    description: t("tools.createTask.description"),
    modelDescription:
      "Create a task for the current user. Supports a due date, an IANA timeZone (default UTC), reminderEnabled for desktop due reminders, and repeatRule (none/daily/weekly/monthly, where each repeat is created after the previous one completes). Both reminders and repeats require dueDate; a time without an offset is interpreted in timeZone. Use it only when the user wants something tracked or scheduled. Do not use it to answer a question, and never create a task the user did not ask for.",
    modeSupport: ["chat"],
    requiresApproval: true,
    manual: {
      enabled: true,
      label: t("tools.createTask.manualLabel"),
      placeholder: t("tools.createTask.placeholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "title",
      primaryFieldLabel: t("tools.createTask.primaryFieldLabel"),
      fields: [
        {
          key: "details",
          label: t("tools.createTask.detailLabel"),
          type: "text",
          placeholder: t("tools.createTask.detailPlaceholder"),
        },
        {
          key: "priority",
          label: t("tools.createTask.priorityLabel"),
          type: "select",
          defaultValue: "medium",
          options: [
            { label: "low", value: "low" },
            { label: "medium", value: "medium" },
            { label: "high", value: "high" },
          ],
        },
        {
          key: "dueDate",
          label: t("tools.createTask.dueLabel"),
          type: "datetime-local",
        },
      ],
    },
    inputSchema: createTaskInputSchema,
    execute: async ({ input }) => createTask(input),
    buildAssistantText: ({ output }) => buildCreateTaskAssistantText(output),
    memory: {
      enabled: true,
      minQuality: 0.5,
      summarize: ({ output }) => {
        const result = output as Awaited<ReturnType<typeof createTask>>;
        if (!result.taskId) return null;

        const summary = [
          tf("tools.createTask.memorySummary", { title: result.title }),
          `status=${result.status}`,
          `priority=${result.priority}`,
          result.dueDate ? `due=${result.dueDate}` : "due=none",
        ].join(t("tools.createTask.memoryJoin"));

        return {
          seed: result.taskId,
          summary,
          quality: 0.95,
          score: 0.9,
          tags: ["task", `status:${result.status}`, `priority:${result.priority}`],
        };
      },
    },
  },
  webSearch: {
    id: "webSearch",
    displayName: "Web Search",
    description: t("tools.webSearch.description"),
    modelDescription:
      "Retrieve external information through web search. Use it when the answer depends on facts outside this workspace: current events, external facts, web sources, links, or anything the user expects to be looked up. Do not use it for questions you can answer from general knowledge, and prefer the knowledge base when the answer is already stored there.",
    modeSupport: ["chat"],
    manual: {
      enabled: true,
      label: t("tools.webSearch.manualLabel"),
      placeholder: t("tools.webSearch.placeholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "query",
      primaryFieldLabel: t("tools.webSearch.primaryFieldLabel"),
      fields: [
        {
          key: "maxResults",
          label: t("tools.webSearch.resultCountLabel"),
          type: "number",
          min: 1,
          max: 10,
          step: 1,
          placeholder: t("tools.createTask.priorityPlaceholder"),
        },
      ],
    },
    resultBudget: {
      inputKey: "maxResults",
      maxPerTurn: 10,
    },
    inputSchema: webSearchInput,
    prepareInput: ({ input, modelRef, trigger, remainingResultBudget, signal }) =>
      resolveWebSearchInput({
        input,
        modelRef,
        trigger,
        maxResultsLimit: remainingResultBudget,
        signal,
      }),
    buildUnavailableOutput: ({ input, reason }) => {
      const query =
        input && typeof input === "object" && "query" in input && typeof input.query === "string"
          ? input.query
          : "";
      return { query, results: [], skipped: reason };
    },
    buildBudgetExceededOutput: ({ input }) => {
      const query =
        input && typeof input === "object" && "query" in input && typeof input.query === "string"
          ? input.query
          : "";

      // Shaped so it cannot be mistaken for a search that ran and found
      // nothing: the assistant text and the tool record both say the lookup was
      // not made.
      return {
        query,
        results: [],
        skipped: "resultBudget",
      };
    },
    execute: async ({ input, signal }) => runWebSearch(input, signal),
    buildAssistantText: ({ output, modelRef }) =>
      buildWebSearchAssistantText({
        result: output,
        modelRef,
      }),
    memory: {
      enabled: true,
      minQuality: 0.4,
      summarize: ({ input, output }) => {
        const result = output as Awaited<ReturnType<typeof runWebSearch>>;
        const count = Array.isArray(result.results) ? result.results.length : 0;
        if (count <= 0) return null;

        return {
          seed: input.query,
          summary: tf("tools.webSearch.memorySummary", { query: input.query, count }),
          quality: Math.min(0.9, 0.45 + count * 0.05),
          score: 0.6,
          tags: ["web-search"],
        };
      },
    },
  },
  listLocalFiles: {
    id: "listLocalFiles",
    displayName: t("tools.listLocalFiles.displayName"),
    description: t("tools.listLocalFiles.description"),
    modelDescription:
      "List what is inside a folder the user has opened to you. Returns names, kinds, sizes and modification times, and says when the listing was cut short. Use it before reading, so you name files that exist rather than guessing. Do not use it to search the whole disk: only the granted folders can be listed at all. Do not use it when the user asked about a topic rather than a file.",
    modeSupport: ["chat"],
    manual: {
      // No manual entry. Choosing a tool from the picker is a way of
      // choosing a tool, not a waiver of the confirmation one that touches the
      // disk asked for, and a file written from a dropdown happens with nothing
      // shown and nothing recorded.
      enabled: false,
      label: t("tools.localFiles.manualLabel"),
      placeholder: t("tools.localFiles.placeholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "path",
      primaryFieldLabel: t("tools.localFiles.pathLabel"),
      fields: [
        { key: "grantId", label: t("tools.localFiles.grantLabel"), type: "text", required: true },
        { key: "depth", label: "depth", type: "number", min: 1, max: 8, step: 1 },
      ],
    },
    inputSchema: listLocalFilesInputSchema,
    execute: async ({ input }) => listGrantedFiles(input),
    buildAssistantText: ({ output }) => {
      const lines = (output.entries as { kind: string; path: string }[]).slice(0, 20).map((entry: { kind: string; path: string }) => `${entry.kind === "folder" ? "[dir]" : "     "} ${entry.path}`);
      const body = lines.length > 0 ? lines.join("\n") : t("tools.localFiles.emptyFolder");
      return [tf("tools.listLocalFiles.result", { folder: output.folder, count: output.entries.length }), body, output.truncated].filter(Boolean).join("\n");
    },
    buildUnavailableOutput: ({ reason }) => ({ folder: "", grantLabel: "", entries: [], truncated: reason === "noDirectoryGranted" ? t("tools.localFiles.noGrant") : reason }),
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
  readLocalFile: {
    id: "readLocalFile",
    displayName: t("tools.readLocalFile.displayName"),
    description: t("tools.readLocalFile.description"),
    modelDescription:
      "Read one text or Markdown file from a folder the user has opened to you. The path is relative to that folder. Use it only for a file the user pointed you at or that a listing just showed you. Do not use it to read configuration, credentials or anything outside the granted folder: those are refused, and asking again wastes the turn. PDFs and Word documents are refused here; the knowledge base is where those are read.",
    modeSupport: ["chat"],
    manual: {
      // No manual entry. Choosing a tool from the picker is a way of
      // choosing a tool, not a waiver of the confirmation one that touches the
      // disk asked for, and a file written from a dropdown happens with nothing
      // shown and nothing recorded.
      enabled: false,
      label: t("tools.localFiles.manualLabel"),
      placeholder: t("tools.localFiles.pathPlaceholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "path",
      primaryFieldLabel: t("tools.localFiles.pathLabel"),
      fields: [{ key: "grantId", label: t("tools.localFiles.grantLabel"), type: "text", required: true }],
    },
    inputSchema: readLocalFileInputSchema,
    execute: async ({ input }) => readGrantedFile(input),
    buildAssistantText: ({ output }) => [
      tf("tools.readLocalFile.result", { path: output.path }),
      output.text.slice(0, 2000),
      output.truncated ? t("tools.localFiles.truncated") : null,
    ].filter(Boolean).join("\n"),
    buildUnavailableOutput: ({ reason }) => ({ path: "", grantLabel: "", byteSize: 0, text: "", truncated: false, unavailable: reason === "noDirectoryGranted" ? t("tools.localFiles.noGrant") : reason } as never),
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
  writeLocalFile: {
    id: "writeLocalFile",
    displayName: t("tools.writeLocalFile.displayName"),
    description: t("tools.writeLocalFile.description"),
    modelDescription:
      "Create a new Markdown or plain text file inside a folder the user has opened to you. The user is asked to approve each one, and an existing file with the same name is never replaced. Use it when the user asked for a file to be produced. Do not use it to edit, patch or overwrite something that already exists, and do not use it to write code that will be executed.",
    modeSupport: ["chat"],
    requiresApproval: true,
    manual: {
      // No manual entry. Choosing a tool from the picker is a way of
      // choosing a tool, not a waiver of the confirmation one that touches the
      // disk asked for, and a file written from a dropdown happens with nothing
      // shown and nothing recorded.
      enabled: false,
      label: t("tools.localFiles.manualLabel"),
      placeholder: t("tools.localFiles.pathPlaceholder"),
      submitLabel: t("tools.common.submitLabel"),
      primaryFieldKey: "path",
      primaryFieldLabel: t("tools.localFiles.pathLabel"),
      fields: [
        { key: "grantId", label: t("tools.localFiles.grantLabel"), type: "text", required: true },
        { key: "content", label: t("tools.localFiles.contentLabel"), type: "text", required: true },
      ],
    },
    inputSchema: writeLocalFileInputSchema,
    /*
     * The binding is taken here, when the input is prepared for the approval,
     * rather than when the file is written. That is the moment the user is
     * looking at the proposal, so it is the moment the world it assumes should
     * be recorded. It travels inside the input, which is what the approval
     * request is stored with and what comes back when the user answers.
     */
    bindForApproval: async (input) => { const bound = { ...(input as object), binding: await bindWriteApproval(input as { grantId: string; path: string }) }; Object.assign(input as object, bound); return bound; },
    execute: async ({ input }) => writeGrantedFile(input),
    buildAssistantText: ({ output }) => tf("tools.writeLocalFile.result", { path: output.path, size: output.byteSize }),
    memory: { enabled: false, minQuality: 1, summarize: () => null },
  },
};

export function getToolDescriptor(toolId: string): AnyToolDescriptor | null {
  return TOOL_CATALOG[toolId] ?? null;
}

export function listToolDescriptors(mode?: ToolMode): AnyToolDescriptor[] {
  const tools = Object.values(TOOL_CATALOG);
  if (!mode) return tools;
  return tools.filter((tool) => tool.modeSupport.includes(mode));
}

export async function listPublicToolCatalog(mode?: ToolMode): Promise<PublicToolCatalogItem[]> {
  const descriptors = listToolDescriptors(mode);
  const availability = await Promise.all(descriptors.map((tool) => toolAvailability(tool.id)));
  return descriptors.map((tool, index) => ({
    ...availability[index],
    id: tool.id,
    displayName: tool.displayName,
    description: tool.description,
    modeSupport: tool.modeSupport,
    manual: tool.manual,
    resultBudget: tool.resultBudget,
  }));
}

export function isToolSupportedInMode(toolId: string, mode: ToolMode): boolean {
  const descriptor = getToolDescriptor(toolId);
  if (!descriptor) return false;
  return descriptor.modeSupport.includes(mode);
}

/**
 * What a step record keeps about its input. Tool arguments can be long or hold
 * whatever the model put there, so the record keeps the shape and a short
 * preview rather than a second copy of the full payload.
 */
/**
 * The condition that stopped the run, in the vocabulary a tool result carries.
 *
 * `checkRunAllowance` names what the run ran out of; a tool result has to say
 * why *this step* did not run. Every refusal collapsed to "runStopped" made a
 * run that had spent its budget indistinguishable from one the user stopped,
 * which is exactly the distinction the model needs to decide whether asking
 * again could ever work.
 */
function skipReasonForRunRefusal(reason: string): ToolSkipReason {
  if (reason === "run-budget-unreadable") return "run-budget-unreadable";
  if (reason.endsWith("-budget")) return "budget";
  return "runStopped";
}

/**
 * The result a refused step returns. It says the step did not run and why,
 * which is different from a tool that ran and found nothing — the model can act
 * on the first and would be misled by the second.
 */
function skippedResult(tool: AnyToolDescriptor, input: unknown, reason: string) {
  const query = input && typeof input === "object" && "query" in input && typeof (input as { query?: unknown }).query === "string"
    ? (input as { query: string }).query
    : "";
  const skipReason = skipReasonForRunRefusal(reason);
  return tool.buildUnavailableOutput?.({ input, reason: skipReason, error: new Error(reason) }) ?? { query, results: [], skipped: skipReason };
}

function summarizeForRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return { value: String(value).slice(0, 200) };
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 8).map(([key, item]) => [
    key,
    typeof item === "string" ? item.slice(0, 200) : item === null || item === undefined ? null : typeof item,
  ]);
  return Object.fromEntries(entries);
}

function capNumericInputValue(input: unknown, key: string, maxValue: number): unknown {
  if (!input || typeof input !== "object" || !Number.isFinite(maxValue)) {
    return input;
  }

  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= maxValue) {
    return input;
  }

  return {
    ...(input as Record<string, unknown>),
    [key]: Math.max(0, Math.trunc(maxValue)),
  };
}

function readNumericInputValue(input: unknown, key: string): number | null {
  if (!input || typeof input !== "object" || !(key in input)) {
    return null;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What a tool needs before it can run at all.
 *
 * An optional tool that is not configured is not broken, it is simply absent:
 * it is not handed to the model, so the model cannot pick it, retry it, or
 * burn a step on it. The manual entry point still refuses it explicitly,
 * because there the user asked for that tool by name.
 */
export type ToolAvailabilityReason = "notConfigured" | "noDirectoryGranted";

export type ToolAvailability = { available: boolean; reason: ToolAvailabilityReason | null; configEntry: string | null };

const LOCAL_FILE_TOOL_IDS = new Set(["listLocalFiles", "readLocalFile", "writeLocalFile"]);

/**
 * Async because one kind of missing configuration is not a missing key: the
 * local-file tools need a folder the user granted, which lives in the database
 * and can be withdrawn between turns. The check is made here, where the tool set
 * is built, so a withdrawn folder means the tool is simply not offered — the
 * model cannot pick it, retry it, or report a read that never happened.
 */
export async function toolAvailability(toolId: string): Promise<ToolAvailability> {
  if (toolId === "webSearch" && !process.env.TAVILY_API_KEY?.trim()) {
    // The reason a tool is missing comes with where to fix it, so the interface
    // can offer the way out instead of only reporting the absence.
    return { available: false, reason: "notConfigured", configEntry: "/settings" };
  }
  if (LOCAL_FILE_TOOL_IDS.has(toolId)) {
    const active = await listActiveGrants().catch(() => []);
    if (active.length === 0) {
      return { available: false, reason: "noDirectoryGranted", configEntry: "/settings" };
    }
  }
  return { available: true, reason: null, configEntry: null };
}

/**
 * The refusal a missing prerequisite turns into, worded for the reason that is
 * actually missing. Built once so the manual entry point and the mid-turn
 * branch cannot drift apart and report a web-search key to a local-file tool.
 */
function unavailabilityError(reason: ToolAvailabilityReason): ApiError {
  return new ApiError({
    code: "CONFIGURATION_ERROR",
    message: reason === "noDirectoryGranted" ? t("lib.tools.localFilesNotGranted") : t("lib.tools.webSearchNotConfigured"),
  });
}

export async function assertToolConfiguration(toolId: string) {
  const availability = await toolAvailability(toolId);
  if (availability.available) return;
  throw unavailabilityError(availability.reason ?? "notConfigured");
}

export /**
 * Whether a failure means "this optional tool is not available right now" or
 * means something the user or the caller has to fix. Only the former is turned
 * into a result: a rejected approval, a bad argument or a refused write is
 * never quietly absorbed into "the tool was unavailable".
 */
async function skipReasonFor(toolId: string, error: unknown): Promise<ToolSkipReason | null> {
  const availability = await toolAvailability(toolId);
  if (!availability.available) return availability.reason ?? "notConfigured";
  if (!(error instanceof ApiError)) return null;
  // Transient upstream conditions: a lookup that failed is not a lookup that
  // found nothing, and the model should not keep asking a service that is
  // already refusing.
  if (["TIMEOUT", "RATE_LIMITED", "UPSTREAM_FAILED", "SERVICE_UNAVAILABLE"].includes(error.code)) {
    return "temporarilyUnavailable";
  }
  return null;
}

export async function createChatToolSet(options?: { modelRef?: ModelRef; toolIds?: string[]; runId?: string | null; usesMemory?: boolean; documentCollections?: string[] }): Promise<ToolSet> {
  const workspaceId = LOCAL_WORKSPACE_ID;
  const allowed = new Set(options?.toolIds ?? []);
  const hasRestriction = allowed.size > 0;
  const resultBudgetUsed = new Map<string, number>();
  const runId = options?.runId ?? null;
  // An unconfigured optional tool is filtered out here rather than mounted and
  // failed later. The model never sees it, so it cannot call it, retry it, or
  // report a search that never happened.
  const candidates = listToolDescriptors("chat").filter((tool) =>
    (hasRestriction ? allowed.has(tool.id) : true) && !(tool.id === "saveMemory" && options?.usesMemory === false));
  const availability = await Promise.all(candidates.map((tool) => toolAvailability(tool.id)));
  const descriptors = candidates.filter((_, index) => availability[index].available);

  const entries = descriptors.map((tool) => [
    tool.id,
    {
      description: tool.modelDescription,
      inputSchema: tool.inputSchema,
        // Mounted as a function so the binding is taken here, not in
        // `prepareInput` — which the SDK calls from inside `execute`, long
        // after the user answered.
        ...(tool.requiresApproval
          ? {
              needsApproval: async (input: unknown) => {
                if (tool.bindForApproval) await tool.bindForApproval(input);
                return true;
              },
            }
          : {}),
      execute: async (input: unknown, callOptions?: { abortSignal?: AbortSignal }) => {
        const startedAt = Date.now();
        // The SDK passes call options as the second argument when a tool runs;
        // its abortSignal carries the user's stop request into every stage.
        const signal = callOptions?.abortSignal;
        // A run that has been stopped, or has spent its budget, does not get to
        // start another step. The refusal is returned as a result so the model
        // can finish with what it has instead of retrying into a wall.
        const reservation = runId
          ? await reserveRunStep({ runId, toolName: tool.id, input: summarizeForRecord(input) })
              .catch(() => ({ step: null, reason: "run-budget-unreadable" }))
          : null;
        if (reservation && !reservation.step) return skippedResult(tool, input, reservation.reason ?? "run-stopped");
        const step = reservation?.step ?? null;
        /**
         * Closes the recorded step, exactly once, on every exit from this
         * wrapper.
         *
         * `checkRunAllowance` counts steps by row, so a step left in "running"
         * would spend budget forever and would appear in the run record as work
         * that never ended. Several exits below — the per-turn result budget, a
         * tool that is not configured, a tool that became unavailable
         * mid-execution — return a normal tool output *without* having executed
         * the tool, so they settle as "skipped": the step was recorded, but
         * nothing ran. Only the real execution path reports "done", and a thrown
         * error reports "failed". The flag keeps a later exit from overwriting a
         * state the wrapper already committed, and the write is swallowed
         * because failed bookkeeping must not turn a successful tool result into
         * a failed turn.
         */
        let stepSettled = false;
        const settleStep = async (data: { state: StepState; output?: unknown; errorCode?: string | null }) => {
          if (!step || stepSettled) return;
          stepSettled = true;
          await updateStep(step.id, { ...data, finished: true }).catch(() => undefined);
        };
        try {
          enforceRateLimit("tools");
          const budget = tool.resultBudget;
          const usedBudget = resultBudgetUsed.get(tool.id) ?? 0;
          const remainingResultBudget = budget ? budget.maxPerTurn - usedBudget : undefined;
          if (budget && typeof remainingResultBudget === "number" && remainingResultBudget <= 0) {
            if (tool.buildBudgetExceededOutput) {
              const output = tool.buildBudgetExceededOutput({
                input,
                remainingResultBudget: 0,
              });

              logToolExecution({
                toolId: tool.id,
                trigger: "auto",
                state: "output-available",
                durationMs: Date.now() - startedAt,
              });

              return output;
            }

            throw new ApiError({
              code: "VALIDATION_ERROR",
              message: `Tool ${tool.id} exceeded the per-turn result budget.`,
              details: {
                inputKey: budget.inputKey,
                maxPerTurn: budget.maxPerTurn,
                used: usedBudget,
                remaining: 0,
              },
            });
          }

          const cappedInput =
            budget && typeof remainingResultBudget === "number"
              ? capNumericInputValue(input, budget.inputKey, remainingResultBudget)
              : input;
          const parsedInput = tool.inputSchema.safeParse(cappedInput);
          if (!parsedInput.success) {
            throw new ApiError({
              code: "VALIDATION_ERROR",
              message: `Invalid ${tool.id} tool input`,
              details: parsedInput.error.flatten(),
            });
          }

          // Checked before the input is prepared, so a tool that is configured
          // away does not spend a planning call first. An optional tool answers
          // instead of failing the turn; anything else still refuses here, where
          // the manual entry point refuses it.
          // Whatever the tool was missing is what the model is told. A folder
          // the user withdrew and a search key that was cleared are both a
          // configuration problem, but only one of them is fixed in settings.
          const unavailability = await toolAvailability(tool.id);
          if (!unavailability.available) {
            const reason = unavailability.reason ?? "notConfigured";
            const error = unavailabilityError(reason);
            const builder = tool.buildUnavailableOutput;
            if (!builder) throw error;
            logToolExecution({ toolId: tool.id, trigger: "auto", state: "output-available", durationMs: Date.now() - startedAt, errorCode: error.code });
            return builder({ input, reason, error });
          }
          const preparedInput = tool.prepareInput
            ? await tool.prepareInput({
                workspaceId,
                input: parsedInput.data,
                modelRef: options?.modelRef,
                trigger: "auto",
                remainingResultBudget,
                signal,
              })
            : parsedInput.data;
          const preparedParsedInput = tool.inputSchema.safeParse(preparedInput);
          if (!preparedParsedInput.success) {
            throw new ApiError({
              code: "VALIDATION_ERROR",
              message: `Invalid ${tool.id} tool input`,
              details: preparedParsedInput.error.flatten(),
            });
          }

          if (budget) {
            const requestedBudget = readNumericInputValue(preparedParsedInput.data, budget.inputKey);
            if (requestedBudget === null) {
              throw new ApiError({
                code: "VALIDATION_ERROR",
                message: `Tool ${tool.id} did not provide required budget field: ${budget.inputKey}`,
                details: {
                  inputKey: budget.inputKey,
                  maxPerTurn: budget.maxPerTurn,
                  used: usedBudget,
                  remaining: remainingResultBudget,
                },
              });
            }

            // The budget was read before the async preparation above; parallel
            // executions would all see the same stale count, so re-check and
            // reserve against the map's current value instead of the snapshot.
            const currentUsedBudget = resultBudgetUsed.get(tool.id) ?? 0;
            const currentRemaining = budget.maxPerTurn - currentUsedBudget;
            if (requestedBudget > currentRemaining) {
              if (tool.buildBudgetExceededOutput) {
                const output = tool.buildBudgetExceededOutput({
                  input: preparedParsedInput.data,
                  remainingResultBudget: Math.max(0, currentRemaining),
                });

                logToolExecution({
                  toolId: tool.id,
                  trigger: "auto",
                  state: "output-available",
                  durationMs: Date.now() - startedAt,
                });

                return output;
              }

              throw new ApiError({
                code: "VALIDATION_ERROR",
                message: `Tool ${tool.id} exceeded the per-turn result budget.`,
                details: {
                  inputKey: budget.inputKey,
                  requested: requestedBudget,
                  maxPerTurn: budget.maxPerTurn,
                  used: currentUsedBudget,
                  remaining: currentRemaining,
                },
              });
            }

            resultBudgetUsed.set(tool.id, currentUsedBudget + requestedBudget);
          }

          let output: Awaited<ReturnType<typeof tool.execute>>;
          try {
            output = await tool.execute({
              workspaceId,
              input: preparedParsedInput.data,
              modelRef: options?.modelRef,
              trigger: "auto",
              signal,
              documentCollections: options?.documentCollections,
              usesMemory: options?.usesMemory,
            });
          } catch (error) {
            // The configuration can disappear between building the tool set and
            // running it — a key cleared in another window, a settings save in
            // between turns. An optional tool that is merely unavailable
            // answers instead of failing the turn, so the model is told once
            // and spends the rest of the turn on what it can do.
            const reason = await skipReasonFor(tool.id, error);
            const builder = tool.buildUnavailableOutput;
            if (!reason || !builder) throw error;
            logToolExecution({
              toolId: tool.id,
              trigger: "auto",
              state: "output-available",
              durationMs: Date.now() - startedAt,
              // The log has to agree with the reason it is logging. A withdrawn
              // folder is the same configuration problem the check above the
              // execution reports, and only a genuinely transient upstream
              // condition is an upstream failure.
              errorCode: reason === "temporarilyUnavailable" ? "UPSTREAM_FAILED" : "CONFIGURATION_ERROR",
            });
            return builder({ input: preparedParsedInput.data, reason, error });
          }
          const requestId =
            output && typeof output === "object" && "requestId" in output && typeof output.requestId === "string"
              ? output.requestId
              : undefined;

          logToolExecution({
            toolId: tool.id,
            trigger: "auto",
            state: "output-available",
            durationMs: Date.now() - startedAt,
            requestId,
          });
          // The step carries the same facts as the log, plus the artifact when
          // the step produced one, so the record and the log cannot disagree.
          await settleStep({ state: "done", output: summarizeForRecord(output) });

          return output;
        } catch (error) {
          const errorCode = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
          logToolExecution({
            toolId: tool.id,
            trigger: "auto",
            state: "output-error",
            durationMs: Date.now() - startedAt,
            errorCode,
          });
          await settleStep({ state: "failed", errorCode });
          throw error;
        } finally {
          // Reached by every early return above that has not already settled the
          // step. Those returns are all refusals to execute the tool, so this
          // only fires for a step that is genuinely "skipped"; a settled step is
          // left alone, which is what keeps the state from being rewritten.
          await settleStep({ state: "skipped" });
        }
      },
    },
  ]);

  return Object.fromEntries(entries);
}
