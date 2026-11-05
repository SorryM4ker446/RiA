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
  chatId?: string | null;
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

/** Where a tool sits when people browse or choose tools. */
export type ToolCategory = "knowledge" | "web" | "workspace" | "tasks" | "context" | "extension";

/**
 * Who can reach a tool, stated once. Every list of tools is derived from this:
 * the slash menu, a template's tool choice, the built-in tool list, and which
 * tools the system prompt may call unavailable.
 */
export type ToolSurface = {
  category: ToolCategory;
  /**
   * How a person chooses it in the composer; null when only the model calls it.
   * `model` sends the message through the model with this tool offered first.
   * `direct` needs no model and runs from the composer's own controls.
   */
  user: { run: "model" | "direct"; hint: string } | null;
  /**
   * How a template treats it: chosen one by one, always allowed because it grants
   * nothing external, allowed along with the tool it is a way of using, or allowed
   * along with any tool, so a template with no tools still has none.
   */
  template: "selectable" | "always" | { follows: string } | "with-any";
  /**
   * Not a tool of the kind people or templates choose. Who drives it differs:
   * `application` is never in the tool set sent to the model, since what it does is
   * decided without asking the model, as when a number crosses a line. `model` is the
   * model's alone: it goes to the model, which can only call what a request defines.
   */
  underlying?: "application" | "model";
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
  surface: ToolSurface;
  /** Caps how many results one turn may pull, to bound cost and latency. */
  resultBudget?: {
    inputKey: string;
    maxPerTurn: number;
  };
  inputSchema: z.ZodType<Input>;
  modelInputSchema?: FlexibleSchema<Input>;
  extensionId?: string;
  /** The connection this tool comes from, as people named it. */
  extensionName?: string;
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
};

export type AnyToolDescriptor = ToolDescriptor<any, any>;

export type PublicToolCatalogItem = {
  extensionId?: string;
  extensionName?: string;
  /** Whether this tool can run right now, and why not when it cannot. */
  available: boolean;
  reason: ToolAvailabilityReason | null;
  /** Where the missing configuration is configured. */
  configEntry: string | null;
  id: string;
  displayName: string;
  description: string;
  modeSupport: ToolMode[];
  surface: ToolSurface;
  /** Whether a call may wait for the user first; the final say can depend on its input. */
  requiresApproval: boolean;
  resultBudget?: {
    inputKey: string;
    maxPerTurn: number;
  };
};


export type ToolAvailabilityReason = "notConfigured" | "noDirectoryGranted" | "disabled" | "notTested" | "toolDisabled";
export type ToolAvailability = { available: boolean; reason: ToolAvailabilityReason | null; configEntry: string | null };
