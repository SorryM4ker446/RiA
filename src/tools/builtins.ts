import { withModelCallSource } from "@/lib/models/call-context";
import { generateText, Output } from "ai";
import { z } from "zod";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { getChatModel } from "@/lib/ai/client";
import { t, tf, formatDateTime } from "@/lib/locale";
import { saveMemory } from "@/lib/memory/store";
import { preferredModel, getModelPreferences } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import type { ModelRef } from "@/lib/models/preferences-schema";
import {
  SEARCH_ANSWER_OUTPUT,
  SEARCH_ANSWER_SYSTEM,
  WEB_ANSWER_OUTPUT,
  WEB_ANSWER_SYSTEM,
} from "@/lib/prompts";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";
import { searchKnowledge, searchKnowledgeInputSchema } from "@/tools/definitions/search-knowledge";
import { documentSourceUrl } from "@/lib/documents/types";
import { runWebSearch, webSearchInput } from "@/tools/definitions/web-search";
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

import type { AnyToolDescriptor, ToolMode, ToolAvailability, ToolTriggerType } from "./types";

const DEFAULT_SEARCH_RESULTS = 5;

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
  signal?: AbortSignal;
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
    const answer = await withModelCallSource("tool", () => generateText({
      model: getChatModel(selectedModel),
      ...(providerOptions ? { providerOptions } : {}),
      system: SEARCH_ANSWER_SYSTEM,
      maxRetries: 0, maxOutputTokens: 1024, abortSignal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      prompt: [
        `User question: ${result.query}`,
        "",
        "Knowledge-base retrieval results (ordered by relevance):",
        JSON.stringify(references, null, 2),
        "",
        SEARCH_ANSWER_OUTPUT,
      ].join("\n"),
    }));

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
  signal?: AbortSignal;
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
    const answer = await withModelCallSource("tool", () => generateText({
      model: getChatModel(selectedModel),
      ...(providerOptions ? { providerOptions } : {}),
      system: WEB_ANSWER_SYSTEM,
      maxRetries: 0, maxOutputTokens: 1024, abortSignal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      prompt: [
        `User question: ${result.query}`,
        "",
        "Web search results (ordered by relevance):",
        JSON.stringify(references, null, 2),
        "",
        ...WEB_ANSWER_OUTPUT,
      ].join("\n"),
    }));

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
    execute: async ({ input, documentCollections, documentRetrievalPolicy, usesMemory, signal }) => searchKnowledge(input, { collections: documentCollections, policy: documentRetrievalPolicy, usesMemory, signal }),
    buildAssistantText: async ({ output, modelRef, signal }) =>
      buildSearchAssistantText({
        result: output,
        modelRef, signal,
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
    buildAssistantText: ({ output, modelRef, signal }) =>
      buildWebSearchAssistantText({
        result: output,
        modelRef, signal,
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

const LOCAL_FILE_TOOL_IDS = new Set(["listLocalFiles", "readLocalFile", "writeLocalFile"]);

/**
 * Async because one kind of missing configuration is not a missing key: the
 * local-file tools need a folder the user granted, which lives in the database
 * and can be withdrawn between turns. The check is made here, where the tool set
 * is built, so a withdrawn folder means the tool is simply not offered — the
 * model cannot pick it, retry it, or report a read that never happened.
 */
export async function builtinToolAvailability(toolId: string): Promise<ToolAvailability> {
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

