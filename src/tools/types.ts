import type { z } from "zod";
import type { FlexibleSchema } from "ai";
import type { ModelRef } from "@/lib/models/preferences-schema";
import type { RetrievalPolicy } from "@/lib/assistants/schema";

export type ToolMode = "chat" | "image" | "video";
export type ToolTriggerType = "manual" | "auto";
export type ToolExecutionState = "output-available" | "output-error";

type ToolExecutionContext<Input> = {
  workspaceId: string;
  input: Input;
  modelRef?: ModelRef;
  trigger: ToolTriggerType;
  signal?: AbortSignal;
  runId?: string | null;
  documentCollections?: string[];
  documentRetrievalPolicy?: RetrievalPolicy;
  usesMemory?: boolean;
};

type ToolBudgetExceededContext = {
  input: unknown;
  remainingResultBudget: number;
};

/** Why an optional tool did not produce a result, in terms the model can read. */
export type ToolSkipReason = "notConfigured" | "noDirectoryGranted" | "disabled" | "notTested" | "toolDisabled" | "budget" | "temporarilyUnavailable" | "runStopped" | "run-budget-unreadable";

type ToolPrepareInputContext<Input> = {
  workspaceId: string;
  input: Input;
  modelRef?: ModelRef;
  trigger: ToolTriggerType;
  remainingResultBudget?: number;
  signal?: AbortSignal;
};

type ToolAssistantTextContext<Input, Output> = {
  signal?: AbortSignal;
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
  /** Sent with its default value but never shown: the tool needs it, the user does not choose it. */
  hidden?: boolean;
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

export type ToolDescriptor<Input = unknown, Output = unknown> = {
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
  modelInputSchema?: FlexibleSchema<Input>;
  extensionId?: string;
  extensionRevision?: number;
  requiresApproval?: boolean | ((input: unknown) => Promise<boolean>);
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
  extensionId?: string;
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


export type ToolAvailabilityReason = "notConfigured" | "noDirectoryGranted" | "disabled" | "notTested" | "toolDisabled";
export type ToolAvailability = { available: boolean; reason: ToolAvailabilityReason | null; configEntry: string | null };
