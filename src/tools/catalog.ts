import { enforceRateLimit } from "@/lib/server/rate-limit";
import { generateText, Output, type ToolSet } from "ai";
import { z } from "zod";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { getChatModel } from "@/lib/ai/client";
import { t, tf, formatDateTime } from "@/lib/locale";
import { saveMemory } from "@/lib/memory/store";
import { preferredModel } from "@/lib/models/preferences";
import {
  SEARCH_ANSWER_OUTPUT,
  SEARCH_ANSWER_SYSTEM,
  WEB_ANSWER_OUTPUT,
  WEB_ANSWER_SYSTEM,
  WEB_SEARCH_PLANNING_SYSTEM,
} from "@/lib/prompts";
import { logToolExecution } from "@/lib/server/tool-log";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";
import { searchKnowledge, searchKnowledgeInputSchema } from "@/tools/definitions/search-knowledge";
import { documentSourceUrl } from "@/lib/documents/types";
import { runWebSearch, webSearchInput } from "@/tools/definitions/web-search";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";

export type ToolMode = "chat" | "image" | "video";
export type ToolTriggerType = "manual" | "auto";
export type ToolExecutionState = "output-available" | "output-error";

type ToolExecutionContext<Input> = {
  workspaceId: string;
  input: Input;
  modelId?: string;
  trigger: ToolTriggerType;
  signal?: AbortSignal;
};

type ToolBudgetExceededContext = {
  input: unknown;
  remainingResultBudget: number;
};

type ToolPrepareInputContext<Input> = {
  workspaceId: string;
  input: Input;
  modelId?: string;
  trigger: ToolTriggerType;
  remainingResultBudget?: number;
  signal?: AbortSignal;
};

type ToolAssistantTextContext<Input, Output> = {
  input: Input;
  output: Output;
  modelId?: string;
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
  modelId?: string;
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
  prepareInput?: (context: ToolPrepareInputContext<Input>) => Promise<Input> | Input;
  buildBudgetExceededOutput?: (context: ToolBudgetExceededContext) => Output;
  execute: (context: ToolExecutionContext<Input>) => Promise<Output>;
  buildAssistantText: (context: ToolAssistantTextContext<Input, Output>) => Promise<string> | string;
  memory: ToolMemoryPolicy<Input, Output>;
};

export type AnyToolDescriptor = ToolDescriptor<any, any>;

export type PublicToolCatalogItem = {
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
  modelId?: string;
}): Promise<string> {
  const { result, modelId } = params;

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
    const selectedModel = await preferredModel("chat", modelId);
    const answer = await generateText({
      model: getChatModel(selectedModel),
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
  modelId?: string;
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

  const maxResultsLimit =
    typeof params.maxResultsLimit === "number" && Number.isFinite(params.maxResultsLimit)
      ? Math.max(1, Math.min(10, Math.trunc(params.maxResultsLimit)))
      : 10;

  try {
    const selectedModel = await preferredModel("chat", params.modelId);
    const { output } = await generateText({
      model: getChatModel(selectedModel),
      output: Output.object({
        schema: z.object({
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(maxResultsLimit)
            .describe("The number of web search results to retrieve before answering."),
        }),
      }),
      system: WEB_SEARCH_PLANNING_SYSTEM.replace("{{maxResultsLimit}}", String(maxResultsLimit)),
      prompt: [
        `Trigger: ${params.trigger}`,
        `User search query: ${params.input.query}`,
        "",
        "Decide maxResults for this web search.",
      ].join("\n"),
    });

    return {
      ...params.input,
      maxResults: output.maxResults,
    };
  } catch (error) {
    console.warn("webSearch result-count planning failed", normalizeApiError(error).code);
    return {
      ...params.input,
      maxResults: Math.min(5, maxResultsLimit),
    };
  }
}

async function buildWebSearchAssistantText(params: {
  result: Awaited<ReturnType<typeof runWebSearch>>;
  modelId?: string;
}): Promise<string> {
  const { result, modelId } = params;
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
    const selectedModel = await preferredModel("chat", modelId);
    const answer = await generateText({
      model: getChatModel(selectedModel),
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
    execute: async ({ input }) => saveMemory({ key: input.key, value: input.value, score: 0.9 }),
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
    execute: async ({ input }) => searchKnowledge(input),
    buildAssistantText: async ({ output, modelId }) =>
      buildSearchAssistantText({
        result: output,
        modelId,
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
    prepareInput: ({ input, modelId, trigger, remainingResultBudget, signal }) =>
      resolveWebSearchInput({
        input,
        modelId,
        trigger,
        maxResultsLimit: remainingResultBudget,
        signal,
      }),
    buildBudgetExceededOutput: ({ input }) => {
      const query =
        input && typeof input === "object" && "query" in input && typeof input.query === "string"
          ? input.query
          : "";

      return {
        query,
        results: [],
      };
    },
    execute: async ({ input, signal }) => runWebSearch(input, signal),
    buildAssistantText: ({ output, modelId }) =>
      buildWebSearchAssistantText({
        result: output,
        modelId,
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
};

export function getToolDescriptor(toolId: string): AnyToolDescriptor | null {
  return TOOL_CATALOG[toolId] ?? null;
}

export function listToolDescriptors(mode?: ToolMode): AnyToolDescriptor[] {
  const tools = Object.values(TOOL_CATALOG);
  if (!mode) return tools;
  return tools.filter((tool) => tool.modeSupport.includes(mode));
}

export function listPublicToolCatalog(mode?: ToolMode): PublicToolCatalogItem[] {
  return listToolDescriptors(mode).map((tool) => ({
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

export function assertToolConfiguration(toolId: string) {
  if (toolId === "webSearch" && !process.env.TAVILY_API_KEY?.trim()) {
    throw new ApiError({ code: "CONFIGURATION_ERROR", message: "TAVILY_API_KEY is not configured." });
  }
}

export function createChatToolSet(options?: { modelId?: string; toolIds?: string[] }): ToolSet {
  const workspaceId = LOCAL_WORKSPACE_ID;
  const allowed = new Set(options?.toolIds ?? []);
  const hasRestriction = allowed.size > 0;
  const resultBudgetUsed = new Map<string, number>();
  const descriptors = listToolDescriptors("chat").filter((tool) =>
    hasRestriction ? allowed.has(tool.id) : true,
  );

  const entries = descriptors.map((tool) => [
    tool.id,
    {
      description: tool.modelDescription,
      inputSchema: tool.inputSchema,
      ...(tool.requiresApproval ? { needsApproval: true } : {}),
      execute: async (input: unknown, callOptions?: { abortSignal?: AbortSignal }) => {
        const startedAt = Date.now();
        // The SDK passes call options as the second argument when a tool runs;
        // its abortSignal carries the user's stop request into every stage.
        const signal = callOptions?.abortSignal;
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

          assertToolConfiguration(tool.id);
          const preparedInput = tool.prepareInput
            ? await tool.prepareInput({
                workspaceId,
                input: parsedInput.data,
                modelId: options?.modelId,
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

          const output = await tool.execute({
            workspaceId,
            input: preparedParsedInput.data,
            modelId: options?.modelId,
            trigger: "auto",
            signal,
          });
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

          return output;
        } catch (error) {
          logToolExecution({
            toolId: tool.id,
            trigger: "auto",
            state: "output-error",
            durationMs: Date.now() - startedAt,
            errorCode: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
          });
          throw error;
        }
      },
    },
  ]);

  return Object.fromEntries(entries);
}
